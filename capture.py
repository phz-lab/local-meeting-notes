"""Local ScreenCaptureKit helper lifecycle; no audio leaves this machine."""

import json, queue, subprocess, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HELPER = ROOT / "work/MeetingAudioCapture.app/Contents/MacOS/MeetingAudioCapture"


class CaptureManager:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.RLock()

    def _events(self, proc, events):
        for line in proc.stdout:
            try:
                events.put(json.loads(line))
            except (ValueError, TypeError):
                pass
        events.put({"event": "exit", "error": "录音组件已退出，请检查系统录音权限。"})

    def start(self, sid, directory):
        with self.lock:
            for old_sid, session in list(self.sessions.items()):
                if (
                    session["process"].poll() is None
                    and self.status(old_sid).get("state") == "stopped"
                ):
                    self.stop(old_sid)
            if any(s["process"].poll() is None for s in self.sessions.values()):
                raise RuntimeError("已有系统录音正在进行，请先结束当前录音。")
            if not HELPER.exists():
                raise RuntimeError("录音组件尚未构建，请先运行「安装依赖.command」。")
            dest = directory / "native"
            dest.mkdir(exist_ok=True)
            # Never overwrite recovered audio when a start request is retried.
            if any(dest.glob("*.caf")):
                raise RuntimeError("这场会议已有录音，请新建会议。")
            log = (dest / "capture.log").open("a")
            events = queue.Queue()
            proc = subprocess.Popen(
                [str(HELPER), str(dest)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
                bufsize=1,
            )
            self.sessions[sid] = {
                "process": proc,
                "events": events,
                "log": log,
                "directory": dest,
            }
            threading.Thread(
                target=self._events, args=(proc, events), daemon=True
            ).start()
        try:
            event = events.get(timeout=90)
            if event.get("event") != "ready":
                raise RuntimeError(event.get("error", "系统录音启动失败。"))
            return self.status(sid)
        except queue.Empty:
            self.stop(sid)
            raise RuntimeError(
                "等待录音权限超时。请允许 macOS 的麦克风及屏幕与系统音频录制权限后新建会议重试。"
            )
        except Exception:
            self.stop(sid)
            raise

    def status(self, sid):
        with self.lock:
            session = self.sessions.get(sid)
            if not session:
                return None
            f = session["directory"] / "capture-status.json"
            try:
                state = json.loads(f.read_text())
            except (OSError, ValueError):
                state = {"state": "starting", "duration": 0}
            state["id"] = sid
            if (
                session["process"].poll() is not None
                and state.get("state") != "stopped"
            ):
                state.update(
                    state="stopped",
                    error=state.get("error")
                    or "录音组件意外退出，已保存的录音可以重试转写。",
                )
            return state

    def active(self):
        with self.lock:
            for sid, session in self.sessions.items():
                if session["process"].poll() is None:
                    state = self.status(sid)
                    if state.get("state") != "stopped":
                        return state
        return None

    def command(self, sid, command):
        with self.lock:
            s = self.sessions.get(sid)
            if not s or s["process"].poll() is not None:
                raise RuntimeError("录音已停止，请提交已有录音转写。")
            s["process"].stdin.write(command + "\n")
            s["process"].stdin.flush()
        # Wait for the helper acknowledgement via its atomically written status.
        expected = "paused" if command == "pause" else "recording"
        for _ in range(30):
            state = self.status(sid)
            if state["state"] == expected:
                return state
            time.sleep(0.05)
        raise RuntimeError("录音组件未确认操作，请检查录音状态。")

    def stop(self, sid):
        with self.lock:
            s = self.sessions.get(sid)
        if not s:
            return None
        p = s["process"]
        if p.poll() is None:
            try:
                p.stdin.write("stop\n")
                p.stdin.flush()
                p.wait(timeout=15)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
        s["log"].close()
        return self.status(sid)

    def shutdown(self):
        for sid in list(self.sessions):
            self.stop(sid)


capture = CaptureManager()
