import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreGraphics

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let s = String(data: data, encoding: .utf8) { print(s); fflush(stdout) }
}
struct CaptureFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
final class AudioTrack {
    let url: URL
    var file: AVAudioFile?
    var format: AVAudioFormat?
    var peak: Float = 0
    var frames: AVAudioFramePosition = 0
    init(_ url: URL) { self.url = url }
    func append(_ sample: CMSampleBuffer, time: Double) throws {
        guard let desc = sample.formatDescription, let f = AVAudioFormat(cmAudioFormatDescription: desc) as AVAudioFormat? else { return }
        let n = CMSampleBufferGetNumSamples(sample)
        guard n > 0, let buffer = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: AVAudioFrameCount(n)) else { return }
        buffer.frameLength = AVAudioFrameCount(n)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(n), into: buffer.mutableAudioBufferList)
        guard status == noErr else { throw CaptureFailure(message: "读取录音片段失败：\(status)") }
        if file == nil {
            format = f
            var settings = f.settings
            settings[AVLinearPCMBitDepthKey] = 16
            settings[AVLinearPCMIsFloatKey] = false
            settings[AVLinearPCMIsNonInterleaved] = false
            file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: f.commonFormat, interleaved: f.isInterleaved)
        }
        guard let file, let format else { return }
        guard format == f else { throw CaptureFailure(message: "录音设备格式改变，请结束录音后重新开始。") }
        // Both sources use the host clock. Fill absent packets with silence, preserving alignment.
        let target = AVAudioFramePosition(max(0, time) * f.sampleRate)
        var gap = target - frames
        while gap > 0 {
            let count = AVAudioFrameCount(min(gap, 48000))
            let silence = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: count)!
            silence.frameLength = count
            for b in UnsafeMutableAudioBufferListPointer(silence.mutableAudioBufferList) {
                if let p = b.mData { memset(p, 0, Int(b.mDataByteSize)) }
            }
            try file.write(from: silence); frames += AVAudioFramePosition(count); gap -= AVAudioFramePosition(count)
        }
        try file.write(from: buffer); frames += AVAudioFramePosition(n)
        peak = 0
        if let data = buffer.floatChannelData {
            let samples = f.isInterleaved ? n * Int(f.channelCount) : n
            for i in stride(from: 0, to: samples, by: 8) { peak = max(peak, abs(data[0][i])) }
        }
    }
    func close() { file = nil }
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let directory: URL
    let queue = DispatchQueue(label: "local.meeting.audio")
    var stream: SCStream?
    var system: AudioTrack
    var mic: AudioTrack
    var base = 0.0
    var pausedAt: Double?
    var pauseTotal = 0.0
    var stopping = false
    var lastStatus = 0.0
    var failure: String?
    var timer: DispatchSourceTimer?
    init(directory: URL) {
        self.directory = directory
        system = AudioTrack(directory.appendingPathComponent("system.caf"))
        mic = AudioTrack(directory.appendingPathComponent("microphone.caf"))
    }
    func now() -> Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }
    func elapsed() -> Double { max(0, (pausedAt ?? now()) - base - pauseTotal) }
    func status() {
        let state: [String: Any] = ["state": stopping ? "stopped" : pausedAt == nil ? "recording" : "paused", "duration": elapsed(), "system_level": system.peak, "mic_level": mic.peak, "system_frames": system.frames, "mic_frames": mic.frames, "error": failure ?? ""]
        if let data = try? JSONSerialization.data(withJSONObject: state) { try? data.write(to: directory.appendingPathComponent("capture-status.json"), options: .atomic) }
    }
    func start() async throws {
        guard #available(macOS 15.0, *) else { throw CaptureFailure(message: "系统声音与麦克风同步录音需要 macOS 15 或更新版本。") }
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else { throw CaptureFailure(message: "麦克风未授权，请在系统设置 → 隐私与安全性 → 麦克风中允许录音组件。") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw CaptureFailure(message: "没有可用的显示器，无法启动系统声音录制。") }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 2; config.height = 2
        config.minimumFrameInterval = CMTime(seconds: 1, preferredTimescale: 1)
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = false
        config.sampleRate = 48000; config.channelCount = 1
        config.captureMicrophone = true
        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
        stream = s; base = now()
        try await s.startCapture()
        queue.sync { status() }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 0.5)
        t.setEventHandler { [weak self] in self?.status() }
        t.resume(); timer = t
        emit(["event": "ready"])
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopping, pausedAt == nil, buffer.isValid else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(buffer).seconds
        let relative = pts - base - pauseTotal
        guard relative.isFinite, relative >= -1, relative <= elapsed() + 2 else {
            failure = "音频时间戳异常，无法保证双路声音同步。"; status(); return
        }
        do {
            if type == .audio { try system.append(buffer, time: relative) }
            if type == .microphone { try mic.append(buffer, time: relative) }
        } catch { failure = error.localizedDescription; status() }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.failure = error.localizedDescription; self.stopping = true; self.timer?.cancel(); self.system.close(); self.mic.close(); self.status(); emit(["event":"error", "error":error.localizedDescription]) }
    }
    func command(_ line: String) async {
        switch line {
        case "pause": queue.sync { if pausedAt == nil { pausedAt = now() }; system.peak = 0; mic.peak = 0; status() }
        case "resume": queue.sync { if let p = pausedAt { pauseTotal += now() - p; pausedAt = nil }; status() }
        case "stop":
            try? await stream?.stopCapture()
            queue.sync { stopping = true; timer?.cancel(); system.close(); mic.close(); status() }
            emit(["event":"stopped"])
        default: break
        }
    }
}

@main struct Main {
    static func main() async {
        guard CommandLine.arguments.count == 2 else { emit(["error":"缺少录音保存目录"]); exit(1) }
        let dir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let recorder = Recorder(directory: dir)
            try await recorder.start()
            // stdin closes when the local service exits; stop capture rather than leave a microphone running.
            await Task.detached {
                while let line = readLine() {
                    await recorder.command(line)
                    if line == "stop" { return }
                }
                await recorder.command("stop")
            }.value
        } catch { emit(["event":"error", "error":error.localizedDescription]); exit(1) }
    }
}
