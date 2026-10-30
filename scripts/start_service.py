from pathlib import Path
import os, subprocess, sys, time, urllib.request

root = Path(__file__).resolve().parent.parent
(root / "work").mkdir(exist_ok=True)
url = "http://127.0.0.1:8766/api/health"


def ready():
    try:
        with urllib.request.urlopen(url, timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


if not ready():
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")
    with (root / "work/server.log").open("a") as log:
        subprocess.Popen(
            [
                str(root / ".venv/bin/python"),
                "-m",
                "uvicorn",
                "server:app",
                "--host",
                "127.0.0.1",
                "--port",
                "8766",
            ],
            cwd=root,
            env=env,
            stdout=log,
            stderr=log,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    for _ in range(40):
        if ready():
            break
        time.sleep(0.25)
    else:
        sys.exit("服务启动失败，请查看 work/server.log")
print("会议记录服务已就绪：http://127.0.0.1:8766")
