"use strict";

const $ = (s) => document.querySelector(s);
const els = {
  login: $("#login"),
  loginForm: $("#login-form"),
  password: $("#password"),
  loginError: $("#login-error"),
  app: $("#app"),
  status: $("#status"),
  banner: $("#google-banner"),
  messages: $("#messages"),
  empty: $("#empty"),
  composer: $("#composer"),
  input: $("#input"),
  action: $("#action"),
  menuBtn: $("#menu-btn"),
  menu: $("#menu"),
  menuGoogle: $("#menu-google"),
  toast: $("#toast"),
  itemTpl: $("#item-tpl"),
};

const MAX_RECORD_MS = 60_000;
const ICONS = {
  event: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  card: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};
let busy = false;
let recorder = null;

// ---------------- API ----------------

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function api(path, { method = "GET", json, body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: json ? { "Content-Type": "application/json", ...headers } : headers,
      body: json ? JSON.stringify(json) : body,
    });
  } catch {
    throw new ApiError("offline", "Can't reach the server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new ApiError("unauthorized", "Please log in again.");
  }
  if (!res.ok) throw new ApiError(data.error || "error", data.message || `Something went wrong (${res.status}).`);
  return data;
}

// ---------------- Views ----------------

function showLogin() {
  els.app.hidden = true;
  els.login.hidden = false;
  setTimeout(() => els.password.focus(), 50);
}

async function showApp() {
  els.login.hidden = true;
  els.app.hidden = false;
  await Promise.all([refreshStatus(), loadHistory()]);
}

function toast(text, ms = 2600) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (els.toast.hidden = true), ms);
}

async function refreshStatus() {
  try {
    const s = await api("/api/status");
    els.banner.hidden = s.google;
    els.menuGoogle.textContent = s.google ? "Reconnect Google" : "Connect Google";
    els.status.replaceChildren(
      pill("Calendar", s.google),
      pill(s.trello.ok ? "Trello" : "Trello", s.trello.ok, s.trello.ok ? s.trello.defaultList : s.trello.error),
    );
  } catch (e) {
    if (e.code !== "unauthorized") els.status.replaceChildren(pill("Offline", false));
  }
}

function pill(label, ok, title) {
  const span = document.createElement("span");
  span.className = ok ? "pill" : "pill off";
  span.textContent = label;
  if (title) span.title = title;
  return span;
}

async function loadHistory() {
  try {
    const history = await api("/api/history");
    els.messages.querySelectorAll(".msg").forEach((m) => m.remove());
    for (const turn of history) addMessage(turn.role === "user" ? "user" : "bot", turn.content);
    syncEmpty();
    scrollDown(false);
  } catch {
    /* not fatal */
  }
}

// ---------------- Messages ----------------

function syncEmpty() {
  els.empty.hidden = !!els.messages.querySelector(".msg");
}

function scrollDown(smooth = true) {
  requestAnimationFrame(() => els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: smooth ? "smooth" : "auto" }));
}

function addMessage(who, text, { className = "" } = {}) {
  const msg = document.createElement("div");
  msg.className = `msg ${who} ${className}`.trim();
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  msg.append(bubble);
  els.messages.append(msg);
  syncEmpty();
  scrollDown();
  return msg;
}

function addTyping() {
  const msg = document.createElement("div");
  msg.className = "msg bot";
  msg.innerHTML = '<div class="bubble typing" aria-label="Thinking"><span></span><span></span><span></span></div>';
  els.messages.append(msg);
  syncEmpty();
  scrollDown();
  return msg;
}

function renderItems(msg, items) {
  if (!items?.length) return;
  const list = document.createElement("div");
  list.className = "items";
  for (const item of items) {
    const node = els.itemTpl.content.firstElementChild.cloneNode(true);
    node.dataset.kind = item.kind;
    node.dataset.ref = item.ref;
    if (item.url) node.href = item.url;
    node.querySelector(".item-icon").innerHTML = ICONS[item.kind] || ICONS.card;
    node.querySelector(".item-title").textContent = item.title;
    node.querySelector(".item-meta").textContent = [item.when, item.where].filter(Boolean).join(" · ");
    list.append(node);
  }
  msg.append(list);

  // Only the newest batch can be undone with the button (undo pops the latest batch).
  els.messages.querySelectorAll(".undo-btn").forEach((b) => b.remove());
  const row = document.createElement("div");
  row.className = "row-actions";
  const undoBtn = document.createElement("button");
  undoBtn.className = "ghost undo-btn";
  undoBtn.textContent = "Undo";
  undoBtn.onclick = () => doUndo(undoBtn);
  row.append(undoBtn);
  msg.append(row);
}

function markRemoved(deleted) {
  for (const d of deleted || []) {
    els.messages.querySelectorAll(`.item[data-ref="${CSS.escape(d.ref)}"]`).forEach((n) => n.classList.add("removed"));
  }
}

function renderError(e) {
  const msg = addMessage("bot", e.message, { className: "error" });
  if (e.code === "google_not_connected") addConnectButton(msg);
  return msg;
}

function addConnectButton(msg) {
  const a = document.createElement("a");
  a.href = "/auth/google";
  a.className = "ghost accent";
  a.textContent = "Connect Google";
  msg.append(a);
}

// ---------------- Sending ----------------

async function send(text, { userMsg } = {}) {
  text = text.trim();
  if (!text || busy) return;
  setBusy(true);
  if (!userMsg) userMsg = addMessage("user", text);
  const typing = addTyping();
  try {
    const res = await api("/api/chat", { method: "POST", json: { message: text } });
    typing.remove();
    const msg = addMessage("bot", res.reply);
    renderItems(msg, res.items);
    markRemoved(res.deleted);
    if (res.deleted?.length) els.messages.querySelectorAll(".undo-btn").forEach((b) => b.remove());
    if (res.needsGoogle) {
      addConnectButton(msg);
      els.banner.hidden = false;
    }
  } catch (e) {
    typing.remove();
    renderError(e);
  } finally {
    setBusy(false);
    scrollDown();
  }
}

async function doUndo(btn) {
  if (busy) return;
  btn.disabled = true;
  setBusy(true);
  try {
    const res = await api("/api/undo", { method: "POST", json: {} });
    btn.remove();
    markRemoved(res.deleted);
    addMessage("bot", res.reply);
  } catch (e) {
    btn.disabled = false;
    renderError(e);
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  busy = b;
  els.action.disabled = b && !recorder;
}

// ---------------- Composer ----------------

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + "px";
}

function syncAction() {
  if (recorder) {
    els.action.dataset.mode = "rec";
    els.action.setAttribute("aria-label", "Stop recording");
  } else if (els.input.value.trim()) {
    els.action.dataset.mode = "send";
    els.action.setAttribute("aria-label", "Send");
  } else {
    els.action.dataset.mode = "mic";
    els.action.setAttribute("aria-label", "Record voice");
  }
}

function submitText() {
  const text = els.input.value;
  if (!text.trim() || busy) return;
  els.input.value = "";
  autosize();
  syncAction();
  send(text);
}

els.input.addEventListener("input", () => {
  autosize();
  syncAction();
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitText();
  }
});
els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  submitText();
});
els.action.addEventListener("click", () => {
  const mode = els.action.dataset.mode;
  if (mode === "send") submitText();
  else if (mode === "rec") stopRecording();
  else startRecording();
});

document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => send(c.textContent)));

// ---------------- Voice ----------------

function pickMime() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/aac"];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
}

async function startRecording() {
  if (busy || recorder) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("Voice recording isn't supported in this browser.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast("Microphone access was blocked. Allow it in your browser settings.");
    return;
  }
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  const started = Date.now();
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(rec.timer);
    clearTimeout(rec.limit);
    recorder = null;
    els.composer.classList.remove("recording");
    els.input.placeholder = "Type or tap the mic…";
    syncAction();
    if (rec.cancelled) return;
    const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
    if (Date.now() - started < 600 || blob.size < 1000) {
      toast("That was a bit short. Tap the mic, speak, then tap again.");
      return;
    }
    transcribeAndSend(blob);
  };

  recorder = rec;
  rec.start(250);
  els.composer.classList.add("recording");
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    els.input.placeholder = `Listening… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}  tap ■ to finish`;
  };
  tick();
  rec.timer = setInterval(tick, 500);
  rec.limit = setTimeout(stopRecording, MAX_RECORD_MS);
  syncAction();
  els.action.disabled = false;
  navigator.vibrate?.(15);
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

async function transcribeAndSend(blob) {
  setBusy(true);
  const userMsg = addMessage("user", "Transcribing…", { className: "pending" });
  try {
    const { text } = await api("/api/transcribe", {
      method: "POST",
      body: blob,
      headers: { "Content-Type": blob.type || "application/octet-stream" },
    });
    userMsg.classList.remove("pending");
    userMsg.querySelector(".bubble").textContent = text;
    const tag = document.createElement("span");
    tag.className = "voice-tag";
    tag.textContent = "🎙 voice";
    userMsg.append(tag);
    setBusy(false);
    await send(text, { userMsg });
  } catch (e) {
    userMsg.remove();
    setBusy(false);
    renderError(e);
  }
}

// ---------------- Menu ----------------

function closeMenu() {
  els.menu.hidden = true;
  els.menuBtn.setAttribute("aria-expanded", "false");
}
els.menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  els.menu.hidden = !els.menu.hidden;
  els.menuBtn.setAttribute("aria-expanded", String(!els.menu.hidden));
});
document.addEventListener("click", (e) => {
  if (!els.menu.contains(e.target)) closeMenu();
});
$("#menu-trello").addEventListener("click", async () => {
  closeMenu();
  try {
    const r = await api("/api/trello/refresh", { method: "POST", json: {} });
    const lists = r.boards.reduce((n, b) => n + b.lists.length, 0);
    toast(`Trello refreshed: ${r.boards.length} boards, ${lists} lists.`);
    refreshStatus();
  } catch (e) {
    toast(e.message);
  }
});
$("#menu-clear").addEventListener("click", async () => {
  closeMenu();
  try {
    await api("/api/history", { method: "DELETE" });
    els.messages.querySelectorAll(".msg").forEach((m) => m.remove());
    syncEmpty();
  } catch (e) {
    toast(e.message);
  }
});
$("#menu-logout").addEventListener("click", async () => {
  closeMenu();
  await api("/api/logout", { method: "POST", json: {} }).catch(() => {});
  showLogin();
});

// ---------------- Login ----------------

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = els.loginForm.querySelector("button");
  btn.disabled = true;
  els.loginError.textContent = "";
  try {
    await api("/api/login", { method: "POST", json: { password: els.password.value } });
    els.password.value = "";
    await showApp();
  } catch (err) {
    els.loginError.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------------- Boot ----------------

(async function boot() {
  syncAction();
  const params = new URLSearchParams(location.search);
  const google = params.get("google");
  if (google) {
    history.replaceState(null, "", "/");
    const msg = {
      connected: "Google Calendar connected ✓",
      denied: "Google connection was cancelled.",
      bad_state: "Google sign-in expired. Try connecting again.",
      failed: "Google didn't return a refresh token. Try connecting again.",
    }[google];
    if (msg) toast(msg, 3500);
  }
  try {
    await api("/api/status");
    await showApp();
  } catch (e) {
    if (e.code !== "unauthorized") {
      showLogin();
      els.loginError.textContent = e.message;
    }
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
