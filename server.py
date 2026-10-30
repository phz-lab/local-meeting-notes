import json, os, re, shutil, subprocess, threading, uuid, time
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from opencc import OpenCC
from capture import capture, HELPER

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "outputs" / "会议记录"
DATA.mkdir(parents=True, exist_ok=True)
MODEL = Path(
    os.environ.get(
        "MEETING_MODEL",
        str(Path.home() / ".cache/hyperframes/whisper/models/ggml-small.bin"),
    )
).expanduser()
app = FastAPI()
lock = threading.RLock()
pool = ThreadPoolExecutor(max_workers=1)
cc = OpenCC("t2s")


def folder(sid):
    if not re.fullmatch(r"[a-f0-9]{32}", sid):
        raise HTTPException(400, "记录编号不正确")
    p = DATA / sid
    if not p.exists():
        raise HTTPException(404, "未找到会议记录")
    return p


def read(p):
    return json.loads((p / "meeting.json").read_text())


def write(p, d):
    tmp = p / "meeting.tmp"
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2))
    tmp.replace(p / "meeting.json")


def update(p, **kw):
    with lock:
        d = read(p)
        d.update(kw)
        write(p, d)
        return d


def transcript(p, d):
    return f"{d['title']}\n时间：{d['created']}\n\n{d.get('text', '')}\n"


def save_text(p, d):
    tmp = p / "文字稿.tmp"
    tmp.write_text(transcript(p, d))
    tmp.replace(p / "文字稿.txt")


for p in DATA.iterdir():
    if (p / "meeting.json").exists():
        d = read(p)
        if d["status"] in ("recording", "queued", "transcribing"):
            update(
                p,
                status="interrupted",
                error="上次录音或转写被中断，已保存的录音可以继续转写。",
            )


@app.middleware("http")
async def local_only(req, call_next):
    host = req.headers.get("host", "").split(":")[0]
    if host not in ("127.0.0.1", "localhost"):
        return Response("仅允许本机访问", 403)
    origin = req.headers.get("origin")
    if origin and origin not in (
        f"http://127.0.0.1:{req.url.port}",
        f"http://localhost:{req.url.port}",
    ):
        return Response("不允许跨站请求", 403)
    return await call_next(req)


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "model_ready": MODEL.exists() and MODEL.stat().st_size > 400_000_000,
        "engine": bool(shutil.which("whisper-cli")),
        "storage": str(DATA),
        "native_ready": HELPER.exists(),
        "version": "1.1.0",
    }


@app.get("/api/meetings")
def meetings():
    with lock:
        items = [read(p) for p in DATA.iterdir() if (p / "meeting.json").exists()]
    return sorted(items, key=lambda d: d["created"], reverse=True)


@app.post("/api/meetings")
async def create(req: Request):
    body = await req.json()
    sid = uuid.uuid4().hex
    p = DATA / sid
    p.mkdir()
    (p / "chunks").mkdir()
    d = {
        "id": sid,
        "title": str(body.get("title") or "未命名会议")[:120],
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": "recording",
        "duration": 0,
        "text": "",
        "segments": [],
        "source": body.get("source", "microphone"),
        "mime": body.get("mime", "audio/webm"),
        "bytes": 0,
        "error": "",
    }
    with lock:
        write(p, d)
        save_text(p, d)
    return d


@app.get("/api/meetings/{sid}")
def get(sid: str):
    with lock:
        return read(folder(sid))


@app.put("/api/meetings/{sid}")
async def edit(sid: str, req: Request):
    p = folder(sid)
    body = await req.json()
    with lock:
        d = read(p)
        for k in ("title", "text", "duration"):
            if k in body:
                d[k] = body[k]
        d["title"] = str(d["title"])[:120]
        d["text"] = str(d["text"])[:5_000_000]
        write(p, d)
        save_text(p, d)
    return d


@app.put("/api/meetings/{sid}/chunks/{seq}")
async def chunk(sid: str, seq: int, req: Request):
    p = folder(sid)
    if seq < 0 or seq > 100000:
        raise HTTPException(400, "分段编号不正确")
    payload = await req.body()
    if len(payload) > 30_000_000:
        raise HTTPException(413, "录音片段过大")
    with lock:
        d = read(p)
        if d["status"] not in ("recording", "interrupted", "error"):
            raise HTTPException(409, "录音已提交")
        f = p / "chunks" / f"{seq:08d}.part"
        tmp = f.with_suffix(".tmp")
        tmp.write_bytes(payload)
        tmp.replace(f)
        d["bytes"] = sum(f.stat().st_size for f in (p / "chunks").glob("*.part"))
        write(p, d)
    return {"saved": True, "seq": seq}


def run_transcription(sid):
    p = folder(sid)
    try:
        update(p, status="transcribing", error="")
        if read(p).get("source") == "system-mic":
            tracks = [
                f
                for f in [p / "native/system.caf", p / "native/microphone.caf"]
                if f.exists() and f.stat().st_size > 100
            ]
            if not tracks:
                raise RuntimeError("没有可用的系统录音，请允许 macOS 录音权限后重试。")
            args = ["ffmpeg", "-nostdin", "-v", "error", "-y"]
            for f in tracks:
                args += ["-i", str(f)]
            if len(tracks) == 2:
                args += [
                    "-filter_complex",
                    "[0:a]aresample=16000,aformat=channel_layouts=mono,volume=0.7[a];[1:a]aresample=16000,aformat=channel_layouts=mono,volume=0.7[b];[a][b]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=false[out]",
                    "-map",
                    "[out]",
                ]
            args += ["-ar", "16000", "-ac", "1", str(p / "录音.wav")]
            subprocess.run(args, check=True, capture_output=True, timeout=600)
        else:
            parts = sorted((p / "chunks").glob("*.part"))
            if not parts:
                raise RuntimeError("没有收到录音，请重新录制。")
            if [int(f.stem) for f in parts] != list(range(len(parts))):
                raise RuntimeError("部分录音尚未保存，请回到原录音浏览器后重试。")
            with (p / "原始录音.webm").open("wb") as out:
                for f in parts:
                    with f.open("rb") as src:
                        shutil.copyfileobj(src, out)
            subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-y",
                    "-i",
                    str(p / "原始录音.webm"),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(p / "录音.wav"),
                ],
                check=True,
                capture_output=True,
                timeout=180,
            )
        with (p / "识别日志.txt").open("w") as logs:
            subprocess.run(
                [
                    "whisper-cli",
                    "-m",
                    str(MODEL),
                    "-f",
                    str(p / "录音.wav"),
                    "-l",
                    "zh",
                    "--prompt",
                    "以下是普通话会议记录，请使用简体中文。",
                    "-t",
                    "6",
                    "-oj",
                    "-of",
                    str(p / "识别结果"),
                ],
                stdout=logs,
                stderr=logs,
                check=True,
                timeout=14400,
            )
        result = json.loads((p / "识别结果.json").read_text())
        segments = []
        for seg in result.get("transcription", []):
            text = cc.convert(seg.get("text", "").strip())
            if text:
                segments.append(
                    {
                        "start": seg.get("offsets", {}).get("from", 0) / 1000,
                        "text": text,
                    }
                )
        text = "\n".join(s["text"] for s in segments)
        with lock:
            d = update(
                p,
                status="done",
                text=text,
                segments=segments,
                error=("未识别到清晰语音，可回听录音后重试。" if not text else ""),
                capture_warning=(
                    "有一路音频没有收到数据，请检查麦克风与系统声音权限。"
                    if read(p).get("source") == "system-mic" and len(tracks) < 2
                    else ""
                ),
            )
            save_text(p, d)
    except Exception as e:
        detail = "录音转换或识别失败，原录音已保留，可以重试。"
        if isinstance(e, RuntimeError):
            detail = str(e)
        (p / "错误日志.txt").write_text(repr(e))
        update(p, status="error", error=detail)


@app.post("/api/meetings/{sid}/finish")
async def finish(sid: str, req: Request):
    p = folder(sid)
    body = await req.json()
    with lock:
        d = read(p)
        if d["status"] in ("queued", "transcribing"):
            return d
        if d.get("source") == "system-mic":
            state = capture.stop(sid)
            if state:
                d["duration"] = state.get("duration", d["duration"])
                write(p, d)
            if not list((p / "native").glob("*.caf")):
                raise HTTPException(400, "未收到系统录音，请检查录音权限")
        elif not list((p / "chunks").glob("*.part")):
            raise HTTPException(400, "录音还未保存，请稍后重试")
        d = update(
            p,
            status="queued",
            duration=d["duration"]
            if d.get("source") == "system-mic"
            else body.get("duration", d["duration"]),
            error="",
        )
        pool.submit(run_transcription, sid)
    return d


@app.get("/api/meetings/{sid}/export")
def export(sid: str):
    p = folder(sid)
    with lock:
        d = read(p)
        save_text(p, d)
    return FileResponse(
        p / "文字稿.txt",
        media_type="text/plain; charset=utf-8",
        filename=re.sub(r"[/\\\x00-\x1f]", "_", d["title"]) + ".txt",
    )


@app.get("/api/meetings/{sid}/audio")
def audio(sid: str):
    p = folder(sid)
    f = p / "录音.wav"
    if not f.exists():
        raise HTTPException(404, "录音正在整理中")
    return FileResponse(f, media_type="audio/wav")


@app.get("/api/capture/active")
def capture_active():
    return capture.active()


@app.post("/api/meetings/{sid}/capture/start")
def capture_start(sid: str):
    p = folder(sid)
    with lock:
        d = read(p)
        if d.get("source") != "system-mic" or d["status"] != "recording":
            raise HTTPException(409, "请新建系统声音会议后再录音")
    try:
        state = capture.start(sid, p)
        update(p, capture_state=state)
        return state
    except RuntimeError as e:
        update(p, status="error", error=str(e))
        raise HTTPException(400, str(e))


@app.get("/api/meetings/{sid}/capture")
def capture_status(sid: str):
    p = folder(sid)
    state = capture.status(sid)
    if state:
        size = sum(f.stat().st_size for f in (p / "native").glob("*.caf"))
        update(p, duration=state.get("duration", 0), bytes=size, capture_state=state)
    return state


@app.post("/api/meetings/{sid}/capture/{command}")
def capture_command(sid: str, command: str):
    folder(sid)
    if command not in ("pause", "resume", "stop"):
        raise HTTPException(400, "不支持的录音操作")
    try:
        return capture.stop(sid) if command == "stop" else capture.command(sid, command)
    except RuntimeError as e:
        raise HTTPException(400, str(e))


@app.on_event("shutdown")
def stop_captures():
    capture.shutdown()


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
