const $ = id => document.getElementById(id);

const home = $("home");
const call = $("call");
const roomInput = $("roomInput");
const homeStatus = $("homeStatus");
const callStatus = $("callStatus");
const roomLabel = $("roomLabel");
const peerText = $("peerText");
const remoteAudio = $("remoteAudio");
const timerEl = $("timer");
const routeBadge = $("routeBadge");
const turnWarn = $("turnWarn");
const unlockBtn = $("unlockBtn");
const createBtn = $("createBtn");
const joinBtn = $("joinBtn");

const FALLBACK_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const ROOM_RE = /^[A-Z0-9_-]{3,40}$/;

// id ประจำแท็บ ใช้ให้เซิร์ฟเวอร์แทนที่ socket เก่าเมื่อเราต่อกลับมาใหม่
const clientId = (() => {
  try {
    let id = sessionStorage.getItem("wc_cid");
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem("wc_cid", id); }
    return id;
  } catch { return crypto.randomUUID(); }
})();

let ws = null;
let pc = null;
let localStream = null;
let roomId = "";
let sid = "";              // id ของ "เซสชันการโทร" แต่ละรอบ กัน candidate เก่าปนกับรอบใหม่
let isOfferer = false;     // คนที่อยู่ในห้องก่อนเป็นฝ่ายสร้าง offer
let iceServers = FALLBACK_ICE;
let hasTurn = false;
let inCall = false;
let busy = false;
let retry = 0;
let retryTimer = null;
let disconnectTimer = null;
let muted = false;
let pending = [];          // ICE candidate ที่มาก่อน remote description
let queue = Promise.resolve(); // ประมวลผลข้อความสัญญาณทีละอัน ป้องกัน race
let timerId = null;
let callStart = 0;
let statsTimer = null;
let wakeLock = null;

// ---------- helpers ----------
const setHomeStatus = t => { homeStatus.textContent = t; };
const setStatus = t => { callStatus.textContent = t; };
const setPeer = (title, status) => {
  peerText.textContent = title;
  if (status) setStatus(status);
};

function normalizeRoom(v) {
  const r = String(v || "").trim().toUpperCase();
  return ROOM_RE.test(r) ? r : "";
}

function randomRoom() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(b => alphabet[b % alphabet.length]).join("");
}

const wsUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- ICE servers ----------
async function loadIce() {
  try {
    const res = await fetch("/api/ice", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    iceServers = Array.isArray(data.iceServers) && data.iceServers.length ? data.iceServers : FALLBACK_ICE;
    hasTurn = !!data.hasTurn;
  } catch {
    iceServers = FALLBACK_ICE;
    hasTurn = false;
  }
  turnWarn.classList.toggle("hidden", hasTurn);
}

// ---------- start / stop ----------
async function startCall(room) {
  if (busy || inCall) return;
  const id = normalizeRoom(room);
  if (!id) return setHomeStatus("รหัสห้องใช้ได้เฉพาะ A-Z, 0-9, - และ _ ความยาว 3-40 ตัว");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return setHomeStatus("ต้องเปิดผ่าน HTTPS และใช้เบราว์เซอร์ที่รองรับไมโครโฟน");
  }

  busy = true;
  createBtn.disabled = joinBtn.disabled = true;
  setHomeStatus("กำลังขอสิทธิ์ไมโครโฟน...");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  } catch {
    busy = false;
    createBtn.disabled = joinBtn.disabled = false;
    return setHomeStatus("ไม่สามารถใช้ไมโครโฟนได้ กรุณาอนุญาต Microphone ในเบราว์เซอร์");
  }

  await loadIce();

  roomId = id;
  inCall = true;
  busy = false;
  retry = 0;
  muted = false;
  resetControls();

  home.classList.add("hidden");
  call.classList.remove("hidden");
  roomLabel.textContent = roomId;
  timerEl.textContent = "00:00";
  setPeer("กำลังรออีกฝ่าย...", "กำลังเชื่อมต่อเซิร์ฟเวอร์...");

  connectWs();
  requestWakeLock();
}

function cleanup() {
  inCall = false;
  busy = false;
  clearTimeout(retryTimer);
  closePeer();
  stopTimer();
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  if (ws) {
    const s = ws;
    ws = null; // ตั้งก่อน close เพื่อไม่ให้ onclose เริ่ม reconnect
    try { s.close(); } catch { /* ignore */ }
  }
  releaseWakeLock();
  createBtn.disabled = joinBtn.disabled = false;
}

function leaveToHome(message = "") {
  cleanup();
  call.classList.add("hidden");
  home.classList.remove("hidden");
  setHomeStatus(message);
}

// ---------- WebSocket ----------
function connectWs() {
  clearTimeout(retryTimer);
  const socket = new WebSocket(wsUrl());
  ws = socket;

  socket.onopen = () => {
    retry = 0;
    socket.send(JSON.stringify({ type: "join", roomId, clientId }));
  };

  socket.onmessage = event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    queue = queue.then(() => onSignal(msg)).catch(err => console.error("signal error:", err));
  };

  socket.onclose = () => {
    if (ws !== socket || !inCall) return;
    setStatus("ขาดการเชื่อมต่อเซิร์ฟเวอร์ กำลังต่อใหม่...");
    const delay = Math.min(1000 * 2 ** retry++, 8000);
    retryTimer = setTimeout(connectWs, delay);
  };

  socket.onerror = () => { /* onclose จะจัดการต่อ */ };
}

async function onSignal(msg) {
  if (!inCall) return;

  switch (msg.type) {
    case "joined":
      if (msg.peers > 0) {
        // เราเป็นคนมาทีหลัง: รอ offer จากคนที่อยู่ก่อน
        isOfferer = false;
        setPeer("กำลังเชื่อมต่อ...", "กำลังเชื่อมต่อเสียง...");
      } else {
        closePeer();
        stopTimer();
        setPeer("กำลังรออีกฝ่าย...", "ส่งลิงก์หรือรหัสห้องให้อีกฝ่าย");
      }
      break;

    case "peer-joined":
      isOfferer = true;
      setPeer("อีกฝ่ายเข้าห้องแล้ว", "กำลังโทร...");
      await startOffer();
      break;

    case "offer":
      await onOffer(msg);
      break;

    case "answer":
      if (pc && msg.sid === sid && pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription(msg.answer);
        await flushPending();
      }
      break;

    case "ice-candidate":
      await onRemoteCandidate(msg);
      break;

    case "peer-left":
      closePeer();
      stopTimer();
      setPeer("อีกฝ่ายวางสายแล้ว", "รออีกฝ่ายกลับเข้ามา");
      break;

    case "full":
      leaveToHome("ห้องนี้มีคนอยู่ครบ 2 คนแล้ว");
      break;

    case "error":
      leaveToHome(msg.message || "เกิดข้อผิดพลาด");
      break;
  }
}

// ---------- WebRTC ----------
function createPeer() {
  closePeer();
  const p = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 2 });
  const mySid = sid;
  pc = p;
  pending = [];

  localStream.getTracks().forEach(t => p.addTrack(t, localStream));

  p.onicecandidate = e => {
    if (e.candidate && p === pc) {
      sendWs({ type: "ice-candidate", sid: mySid, candidate: e.candidate });
    }
  };

  p.ontrack = e => {
    remoteAudio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    playRemote();
  };

  p.onconnectionstatechange = () => {
    if (p === pc) onPcState(p.connectionState);
  };
}

function closePeer() {
  clearTimeout(disconnectTimer);
  clearInterval(statsTimer);
  statsTimer = null;
  routeBadge.classList.add("hidden");
  if (pc) {
    const old = pc;
    pc = null;
    old.onicecandidate = old.ontrack = old.onconnectionstatechange = null;
    try { old.close(); } catch { /* ignore */ }
  }
  remoteAudio.srcObject = null;
  pending = [];
}

async function startOffer() {
  sid = crypto.randomUUID();
  createPeer();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendWs({ type: "offer", sid, offer: pc.localDescription });
}

async function onOffer(msg) {
  isOfferer = false;
  // offer ที่ sid ใหม่ = เซสชันใหม่; sid เดิม = ICE restart ในเซสชันเดิม
  if (!pc || msg.sid !== sid) {
    sid = msg.sid;
    createPeer();
  }
  await pc.setRemoteDescription(msg.offer);
  await flushPending();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendWs({ type: "answer", sid, answer: pc.localDescription });
}

async function onRemoteCandidate(msg) {
  if (!pc || msg.sid !== sid || !msg.candidate) return;
  if (!pc.remoteDescription) {
    pending.push(msg.candidate);
    return;
  }
  try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn("addIceCandidate:", e); }
}

async function flushPending() {
  const list = pending;
  pending = [];
  for (const c of list) {
    try { await pc.addIceCandidate(c); } catch (e) { console.warn("addIceCandidate:", e); }
  }
}

function onPcState(state) {
  clearTimeout(disconnectTimer);

  if (state === "connected") {
    setPeer("กำลังคุยสาย", "เชื่อมต่อแล้ว");
    startTimer();
    checkRoute();
    clearInterval(statsTimer);
    statsTimer = setInterval(checkRoute, 5000);
  } else if (state === "disconnected") {
    setStatus("สัญญาณไม่เสถียร กำลังพยายามต่อใหม่...");
    disconnectTimer = setTimeout(iceRestart, 3000);
  } else if (state === "failed") {
    setStatus(hasTurn
      ? "เชื่อมต่อไม่สำเร็จ กำลังลองใหม่..."
      : "เชื่อมต่อตรงไม่ได้ (เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า TURN)");
    iceRestart();
  }
}

async function iceRestart() {
  // เฉพาะฝั่ง offerer เท่านั้นที่เริ่ม negotiation เพื่อไม่ให้ชนกัน
  if (!pc || !isOfferer || pc.signalingState !== "stable") return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    sendWs({ type: "offer", sid, offer: pc.localDescription });
  } catch (e) {
    console.warn("iceRestart:", e);
  }
}

async function checkRoute() {
  if (!pc) return;
  try {
    const stats = await pc.getStats();
    let pair;
    stats.forEach(r => {
      if (r.type === "transport" && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    });
    if (!pair) {
      stats.forEach(r => {
        if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r;
      });
    }
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
    routeBadge.textContent = relayed ? "เชื่อมผ่านรีเลย์ (TURN)" : "เชื่อมต่อตรง (P2P)";
    routeBadge.classList.remove("hidden");
  } catch { /* ไม่สำคัญ */ }
}

// ---------- audio / UI ----------
function playRemote() {
  remoteAudio.play().then(
    () => unlockBtn.classList.add("hidden"),
    () => unlockBtn.classList.remove("hidden") // เบราว์เซอร์บล็อกเล่นเสียงอัตโนมัติ
  );
}

function startTimer() {
  if (timerId) return;
  callStart = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - callStart) / 1000);
    timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  timerId = setInterval(tick, 1000);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

function resetControls() {
  remoteAudio.muted = false;
  $("muteBtn").innerHTML = "🎤<span>ปิดไมค์</span>";
  $("speakerBtn").innerHTML = "🔊<span>เสียง</span>";
  unlockBtn.classList.add("hidden");
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* ไม่รองรับก็ข้าม */ }
}

function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && inCall) {
    requestWakeLock();
    remoteAudio.play().catch(() => {});
  }
});

// ---------- events ----------
createBtn.onclick = () => {
  const room = randomRoom();
  roomInput.value = room;
  startCall(room);
};

joinBtn.onclick = () => startCall(roomInput.value);

roomInput.addEventListener("keydown", e => {
  if (e.key === "Enter") startCall(roomInput.value);
});

$("muteBtn").onclick = () => {
  muted = !muted;
  localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
  $("muteBtn").innerHTML = muted ? "🔇<span>เปิดไมค์</span>" : "🎤<span>ปิดไมค์</span>";
};

$("speakerBtn").onclick = () => {
  remoteAudio.muted = !remoteAudio.muted;
  $("speakerBtn").innerHTML = remoteAudio.muted ? "🔇<span>ปิดเสียง</span>" : "🔊<span>เสียง</span>";
};

unlockBtn.onclick = () => playRemote();

$("hangupBtn").onclick = () => leaveToHome("");

$("copyBtn").onclick = async () => {
  const url = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    $("copyBtn").textContent = "คัดลอกแล้ว ✓";
    setTimeout(() => { $("copyBtn").textContent = "คัดลอกลิงก์"; }, 1500);
  } catch {
    prompt("คัดลอกลิงก์นี้:", url);
  }
};

// เปิดผ่านลิงก์ที่แชร์มา: เติมรหัสห้องให้ และเน้นปุ่ม "เข้าห้อง"
const sharedRoom = normalizeRoom(new URLSearchParams(location.search).get("room"));
if (sharedRoom) {
  roomInput.value = sharedRoom;
  joinBtn.classList.add("primary");
  createBtn.classList.remove("primary");
  setHomeStatus("มีคนชวนคุณเข้าห้องโทร — กด “เข้าห้อง” แล้วอนุญาตไมโครโฟน");
}

window.addEventListener("pagehide", () => {
  if (inCall) cleanup();
});
