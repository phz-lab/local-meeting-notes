const $ = (id) => document.getElementById(id);
let meetings = [],
  current = null,
  rec = null,
  stream = null,
  live = null,
  started = 0,
  elapsed = 0,
  pauseAt = 0,
  seq = 0,
  ctx = null,
  analyser = null,
  saveTimer = null,
  editChain = Promise.resolve(),
  uploadChain = Promise.resolve(),
  db;
let lastText = "",
  lastTitle = "",
  busy = false,
  nativeState = null;
const isNative = () => current?.source === "system-mic";
const statuses = {
  recording: "录音未结束",
  queued: "等待转写",
  transcribing: "正在本机转写",
  done: "已完成",
  interrupted: "录音待恢复",
  error: "需要重试",
};
const clock = (s) =>
  [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s) % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
function notice(s = "") {
  $("notice").hidden = !s;
  $("notice").textContent = s;
}
async function api(url, opts = {}) {
  let r = await fetch(url, opts);
  if (!r.ok) {
    let e;
    try {
      e = await r.json();
    } catch {}
    throw Error(e?.detail || "本机服务连接失败，请确认服务已启动。");
  }
  return r.json();
}
const json = (method, data) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
function transaction(mode, fn) {
  return new Promise((resolve, reject) => {
    let t = db.transaction("chunks", mode),
      s = t.objectStore("chunks"),
      req = fn(s);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
async function pending(sid) {
  let all = await transaction("readonly", (s) => s.getAll());
  return all.filter((x) => x.sid === sid).sort((a, b) => a.seq - b.seq);
}
async function uploadAll(sid) {
  let rows = await pending(sid);
  for (let r of rows) {
    await api(`/api/meetings/${sid}/chunks/${r.seq}`, {
      method: "PUT",
      body: r.blob,
    });
    await transaction("readwrite", (s) => s.delete(r.key));
  }
  if (current?.id === sid)
    $("save").textContent =
      "录音已保存到本机 · " +
      new Date().toLocaleTimeString("zh-CN", { hour12: false });
}
function queueUpload(sid) {
  uploadChain = uploadChain.catch(() => {}).then(() => uploadAll(sid));
  uploadChain.catch(() => {
    $("save").textContent = "暂未同步，录音已缓存在浏览器";
    notice("录音暂存在当前浏览器，请保持页面打开。连接恢复后会自动重试保存。");
  });
  return uploadChain;
}
async function refresh() {
  meetings = await api("/api/meetings");
  renderList();
}
function renderList() {
  $("count").textContent = meetings.length;
  let list = $("list");
  list.replaceChildren();
  for (let m of meetings) {
    let b = document.createElement("button");
    b.className = m.id === current?.id ? "selected" : "";
    let title = document.createElement("strong");
    title.textContent = m.title;
    let sub = document.createElement("small");
    sub.textContent =
      new Date(m.created).toLocaleDateString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
      }) +
      " · " +
      statuses[m.status];
    b.append(title, sub);
    b.onclick = () => select(m.id);
    list.append(b);
  }
}
async function select(id) {
  if (live && id !== live) {
    notice("请先结束当前录音，再切换会议。");
    return;
  }
  await persist();
  current = await api("/api/meetings/" + id);
  paint();
  renderList();
  localStorage.setItem("meeting-selected", id);
}
function paint() {
  let m = current,
    active = !!live,
    inProgress = m && ["queued", "transcribing"].includes(m.status);
  $("title").value = m?.title || "";
  $("breadcrumb").textContent = m?.title || "新会议";
  $("meta").textContent = m
    ? new Date(m.created).toLocaleString("zh-CN", { hour12: false }) +
      " · 中文转写"
    : "中文转写 · 停止录音后生成文字";
  $("timer").textContent = clock(m?.duration || 0);
  $("text").value = m?.text || "";
  lastText = $("text").value;
  lastTitle = $("title").value;
  $("text").hidden = !m?.text;
  $("empty").hidden = !!m?.text;
  $("export").classList.toggle("disabled", !m);
  $("export").setAttribute("aria-disabled", !m);
  if (m) $("export").href = `/api/meetings/${m.id}/export`;
  $("record").hidden = active || inProgress || !!(m && m.bytes);
  $("record").disabled = busy;
  $("finish").hidden = !(
    active ||
    (m?.bytes && ["recording", "interrupted", "error"].includes(m.status))
  );
  $("finish").textContent = active ? "结束并转写" : "转写已保存的录音";
  $("pause").hidden = !active;
  $("retry").hidden = !(m && ["done", "error"].includes(m.status));
  $("status").textContent = active
    ? "● 正在录音"
    : inProgress
      ? m.status === "queued"
        ? "◷ 等待本机转写"
        : "◷ 正在本机识别中文…"
      : m
        ? statuses[m.status]
        : "● 准备就绪";
  $("status").className = active ? "recording" : "";
  $("source").disabled = active || inProgress;
  if (m) $("source").value = m.source || "microphone";
  $("source-levels").hidden = !active || !isNative();
  $("meter").hidden = active && isNative();
  $("hint").textContent = active
    ? isNative()
      ? "同时录制麦克风与电脑系统声音；仅保存音频，停止后在本机生成中文文字稿。"
      : "录音每 5 秒保存一次。结束后将生成中文文字稿。"
    : inProgress
      ? "录音已保存，正在本机处理。可以切换到其他页面，服务运行时转写会继续。"
      : $("source").value === "system-mic"
        ? "同时录制电脑播放的声音与麦克风，戴耳机也能记录双方；首次使用需允许 macOS 录音权限。"
        : "仅录制麦克风；戴耳机时通常录不到对方，请切换为电脑声音＋麦克风。";
  $("save").textContent = m?.bytes ? "录音已保存到本机" : "尚未开始录音";
  $("audio").hidden = !(m && ["done", "error"].includes(m.status));
  if (!$("audio").hidden) $("audio").src = `/api/meetings/${m.id}/audio`;
  notice(m?.error || m?.capture_warning || "");
}
async function persist() {
  clearTimeout(saveTimer);
  if (!current) return;
  let sid = current.id,
    title = $("title").value.trim() || "未命名会议",
    text = $("text").value;
  let changes = {};
  if (title !== lastTitle) changes.title = title;
  if (text !== lastText) changes.text = text;
  if (!Object.keys(changes).length) return;
  editChain = editChain
    .catch(() => {})
    .then(async () => {
      let m = await api("/api/meetings/" + sid, json("PUT", changes));
      if (current?.id === sid) {
        current.title = m.title;
        if ("text" in changes) current.text = text;
        lastTitle = title;
        $("breadcrumb").textContent = title;
        $("textsave").textContent =
          "已自动保存 · " +
          new Date().toLocaleTimeString("zh-CN", { hour12: false });
        lastText = text;
      }
      await refresh();
    });
  try {
    await editChain;
  } catch (e) {
    notice("文字保存失败：" + e.message);
    throw e;
  }
}
for (let id of ["title", "text"])
  $(id).oninput = () => {
    if (!current) {
      return;
    }
    $("textsave").textContent = "正在保存…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persist().catch(() => {}), 600);
  };
$("new").onclick = async () => {
  if (live || busy) {
    notice("请先结束当前录音。");
    return;
  }
  await persist();
  current = null;
  nativeState = null;
  $("source").value = "system-mic";
  localStorage.removeItem("meeting-selected");
  paint();
  await refresh();
  $("title").focus();
};
const browserRecord = async () => {
  if (busy) return;
  busy = true;
  $("record").disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw Error("当前浏览器不支持录音，请使用 Chrome 或 Safari 打开本页。");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    let mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    current = await api(
      "/api/meetings",
      json("POST", {
        title:
          $("title").value.trim() ||
          new Date().toLocaleDateString("zh-CN") + " 会议记录",
        mime: rec.mimeType,
      }),
    );
    live = current.id;
    seq = 0;
    elapsed = 0;
    started = Date.now();
    pauseAt = 0;
    uploadChain = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      let sid = live,
        index = seq++;
      uploadChain = uploadChain
        .catch(() => {})
        .then(async () => {
          await transaction("readwrite", (s) =>
            s.put({ key: sid + ":" + index, sid, seq: index, blob: e.data }),
          );
          await uploadAll(sid);
        });
      uploadChain.catch(() => {
        $("save").textContent = "已缓存到浏览器，等待本机保存";
      });
    };
    rec.start(5000);
    try {
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
    } catch {}
    paint();
    await refresh();
    localStorage.setItem("meeting-selected", live);
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop());
    notice(
      e.name === "NotAllowedError"
        ? "麦克风未授权。请在地址栏的网站权限中允许麦克风，然后重试。"
        : e.message,
    );
  } finally {
    busy = false;
    $("record").disabled = false;
  }
};
const browserPause = () => {
  if (!rec) return;
  if (rec.state === "recording") {
    rec.pause();
    elapsed += (Date.now() - started) / 1000;
    pauseAt = Date.now();
    $("pause").textContent = "继续";
    $("status").textContent = "Ⅱ 已暂停";
  } else {
    rec.resume();
    started = Date.now();
    pauseAt = 0;
    $("pause").textContent = "暂停";
    $("status").textContent = "● 正在录音";
  }
};
async function finalize() {
  if (!current || busy) return;
  busy = true;
  $("finish").disabled = true;
  try {
    let sid = current.id,
      duration = current.duration || 0;
    if (live && isNative()) {
      let state = await api(
        `/api/meetings/${sid}/capture/stop`,
        json("POST", {}),
      );
      duration = state?.duration || elapsed;
      current.duration = duration;
      live = null;
      nativeState = null;
      $("pause").textContent = "暂停";
    } else if (live) {
      duration = elapsed + (pauseAt ? 0 : (Date.now() - started) / 1000);
      await new Promise((resolve) => {
        rec.onstop = resolve;
        rec.stop();
      });
      stream.getTracks().forEach((t) => t.stop());
      await ctx?.close();
      ctx = null;
      analyser = null;
      current.duration = duration;
      live = null;
      rec = null;
      $("pause").textContent = "暂停";
    }
    await uploadChain.catch(() => {});
    await uploadAll(sid);
    await persist();
    current = await api(
      `/api/meetings/${sid}/finish`,
      json("POST", { duration }),
    );
    paint();
    await refresh();
  } catch (e) {
    notice(e.message + "；已保存的录音会保留，可点击重试。");
    $("finish").hidden = false;
    $("finish").textContent = "重试保存并转写";
  } finally {
    busy = false;
    $("finish").disabled = false;
  }
}
$("finish").onclick = finalize;
$("retry").onclick = finalize;
$("export").onclick = async (e) => {
  if (!current) return;
  e.preventDefault();
  await persist();
  location.href = `/api/meetings/${current.id}/export`;
};
setInterval(() => {
  if (live) {
    let secs = elapsed + (pauseAt ? 0 : (Date.now() - started) / 1000);
    $("timer").textContent = clock(secs);
    if (analyser && !pauseAt) {
      let data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      document
        .querySelectorAll(".meter span")
        .forEach(
          (el, i) => (el.style.height = 4 + (data[i * 3] / 255) * 26 + "px"),
        );
    }
  }
}, 180);
setInterval(async () => {
  try {
    if (live && isNative()) {
      await pollNative();
      return;
    }
    if (live) {
      queueUpload(live);
      if (current) {
        let duration = elapsed + (pauseAt ? 0 : (Date.now() - started) / 1000);
        await api("/api/meetings/" + live, json("PUT", { duration }));
      }
      return;
    }
    if (current && ["queued", "transcribing"].includes(current.status)) {
      let m = await api("/api/meetings/" + current.id);
      if (m.status !== current.status) {
        current = m;
        paint();
        await refresh();
      }
    }
  } catch (e) {
    notice(e.message);
  }
}, 3000);
window.addEventListener("beforeunload", (e) => {
  if (live) {
    e.preventDefault();
    e.returnValue = "录音还未结束";
  }
  if (current) {
    let changes = {};
    if ($("title").value !== lastTitle) changes.title = $("title").value;
    if ($("text").value !== lastText) changes.text = $("text").value;
    if (Object.keys(changes).length)
      fetch("/api/meetings/" + current.id, {
        ...json("PUT", changes),
        keepalive: true,
      }).catch(() => {});
  }
});
(async () => {
  try {
    db = await new Promise((resolve, reject) => {
      let r = indexedDB.open("local-meeting-recorder", 1);
      r.onupgradeneeded = () =>
        r.result.createObjectStore("chunks", { keyPath: "key" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    let h = await api("/api/health");
    $("health").textContent =
      h.model_ready && h.engine ? "● 本地识别已就绪" : "识别模型或引擎未就绪";
    $("storage").title = h.storage;
    await refresh();
    let sid = localStorage.getItem("meeting-selected");
    let active = await api("/api/capture/active");
    if (active) {
      sid = active.id;
      live = sid;
      nativeState = active;
      elapsed = active.duration || 0;
      started = Date.now();
      pauseAt = active.state === "paused" ? Date.now() : 0;
    }
    if (sid && meetings.some((m) => m.id === sid)) {
      current = await api("/api/meetings/" + sid);
      paint();
      renderList();
    }
    let cached = await transaction("readonly", (s) => s.getAll());
    for (let sid of new Set(cached.map((c) => c.sid))) {
      await uploadAll(sid);
    }
    if (active) await pollNative();
    if (cached.length) notice("已恢复上次未同步的录音片段，可以继续转写。");
  } catch (e) {
    notice(e.message);
  }
})();

async function pollNative() {
  if (!live || !isNative()) return;
  const sid = live;
  const state = await api(`/api/meetings/${sid}/capture`);
  if (!state || current?.id !== sid || live !== sid) return;
  nativeState = state;
  elapsed = state.duration || 0;
  started = Date.now();
  pauseAt = state.state === "paused" ? Date.now() : 0;
  $("pause").textContent = state.state === "paused" ? "继续" : "暂停";
  $("status").textContent =
    state.state === "paused" ? "Ⅱ 已暂停" : "● 正在录音";
  $("mic-level").value = Math.min(1, state.mic_level || 0);
  $("system-level").value = Math.min(1, state.system_level || 0);
  $("save").textContent =
    "双路音频已保存到本机 · " + clock(state.duration || 0);
  if (state.error) notice(state.error);
  if (state.state === "stopped") {
    live = null;
    current.duration = state.duration || 0;
    current.bytes = 1;
    paint();
    notice(state.error || "录音已停止，可点击「转写已保存的录音」。");
  }
}
$("record").onclick = async () => {
  if ($("source").value !== "system-mic") return browserRecord();
  if (busy) return;
  busy = true;
  $("record").disabled = true;
  $("source").disabled = true;
  notice(
    "正在启动本地双路录音。若出现 macOS 权限提示，请允许麦克风与屏幕及系统音频录制。",
  );
  try {
    const active = await api("/api/capture/active");
    if (active) throw Error("已有系统录音正在进行，请先结束该录音。");
    current = await api(
      "/api/meetings",
      json("POST", {
        title:
          $("title").value.trim() ||
          new Date().toLocaleDateString("zh-CN") + " 会议记录",
        source: "system-mic",
        mime: "audio/wav",
      }),
    );
    localStorage.setItem("meeting-selected", current.id);
    nativeState = await api(
      `/api/meetings/${current.id}/capture/start`,
      json("POST", {}),
    );
    live = current.id;
    elapsed = nativeState.duration || 0;
    started = Date.now();
    pauseAt = 0;
    paint();
    await refresh();
    await pollNative();
  } catch (e) {
    notice(e.message);
    await refresh();
  } finally {
    busy = false;
    $("record").disabled = false;
    $("source").disabled = !!live;
  }
};
$("pause").onclick = async () => {
  if (!isNative()) return browserPause();
  if (!live || busy) return;
  $("pause").disabled = true;
  try {
    await api(
      `/api/meetings/${live}/capture/${nativeState?.state === "paused" ? "resume" : "pause"}`,
      json("POST", {}),
    );
    await pollNative();
  } catch (e) {
    notice(e.message);
  } finally {
    $("pause").disabled = false;
  }
};
$("source").onchange = () => paint();
