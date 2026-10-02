const $ = id => document.getElementById(id);

const home = $("home");
const call = $("call");
const roomInput = $("roomInput");
const homeStatus = $("homeStatus");
const callStatus = $("callStatus");
const roomLabel = $("roomLabel");
const peerText = $("peerText");
const remoteAudio = $("remoteAudio");

let ws;
let pc;
let localStream;
let roomId;
let initiator = false;
let muted = false;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

function randomRoom() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function wsUrl() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

async function start(room) {
  roomId = room.trim().toUpperCase();
  if (!roomId) return setHomeStatus("กรุณาใส่รหัสห้อง");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    return setHomeStatus("ไม่สามารถใช้ไมโครโฟนได้ กรุณาอนุญาต Microphone ในเบราว์เซอร์");
  }

  home.classList.add("hidden");
  call.classList.remove("hidden");
  roomLabel.textContent = roomId;
  callStatus.textContent = "กำลังเชื่อมต่อเซิร์ฟเวอร์...";

  ws = new WebSocket(wsUrl());

  ws.onopen = () => ws.send(JSON.stringify({ type: "join", roomId }));

  ws.onmessage = async event => {
    const msg = JSON.parse(event.data);

    if (msg.type === "joined") {
      initiator = msg.initiator;
      peerText.textContent = msg.peerCount === 1 ? "กำลังรออีกฝ่าย..." : "กำลังเชื่อมต่อ...";
      callStatus.textContent = msg.peerCount === 1 ? "ส่งรหัสห้องให้อีกฝ่าย" : "กำลังเชื่อมต่อเสียง...";
      if (initiator && msg.peerCount === 2) await makeOffer();
    }

    if (msg.type === "peer-joined") {
      peerText.textContent = "อีกฝ่ายเข้าห้องแล้ว";
      callStatus.textContent = "กำลังโทร...";
      if (initiator) await makeOffer();
    }

    if (msg.type === "offer") {
      await ensurePeer();
      await pc.setRemoteDescription(msg.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type:"answer", answer: pc.localDescription }));
    }

    if (msg.type === "answer") {
      await pc.setRemoteDescription(msg.answer);
    }

    if (msg.type === "ice-candidate") {
      if (pc) {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      }
    }

    if (msg.type === "peer-left") {
      peerText.textContent = "อีกฝ่ายวางสายแล้ว";
      callStatus.textContent = "รออีกฝ่ายกลับเข้ามา";
      remoteAudio.srcObject = null;
      if (pc) { pc.close(); pc = null; }
    }

    if (msg.type === "full") {
      setHomeStatus("ห้องนี้มีคนอยู่ครบ 2 คนแล้ว");
      hangup();
    }

    if (msg.type === "error") setHomeStatus(msg.message);
  };

  ws.onclose = () => {
    if (!call.classList.contains("hidden")) callStatus.textContent = "การเชื่อมต่อเซิร์ฟเวอร์สิ้นสุด";
  };
}

async function ensurePeer() {
  if (pc) return;

  pc = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = event => {
    if (event.candidate && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type:"ice-candidate", candidate:event.candidate }));
    }
  };

  pc.ontrack = event => {
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected") {
      peerText.textContent = "กำลังคุยสาย";
      callStatus.textContent = "เชื่อมต่อแล้ว";
    } else if (["failed","disconnected"].includes(state)) {
      callStatus.textContent = "การเชื่อมต่อมีปัญหา";
    }
  };
}

async function makeOffer() {
  await ensurePeer();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type:"offer", offer: pc.localDescription }));
}

function hangup() {
  if (pc) { pc.close(); pc = null; }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  call.classList.add("hidden");
  home.classList.remove("hidden");
}

function setHomeStatus(text) { homeStatus.textContent = text; }

$("createBtn").onclick = () => {
  const room = randomRoom();
  roomInput.value = room;
  start(room);
};

$("joinBtn").onclick = () => start(roomInput.value);

$("muteBtn").onclick = () => {
  muted = !muted;
  localStream?.getAudioTracks().forEach(t => t.enabled = !muted);
  $("muteBtn").innerHTML = muted ? "🔇<span>เปิดไมค์</span>" : "🎤<span>ปิดไมค์</span>";
};

$("speakerBtn").onclick = async () => {
  remoteAudio.muted = !remoteAudio.muted;
  $("speakerBtn").innerHTML = remoteAudio.muted ? "🔇<span>ปิดเสียง</span>" : "🔊<span>เสียง</span>";
};

$("hangupBtn").onclick = hangup;

$("copyBtn").onclick = async () => {
  const url = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    $("copyBtn").textContent = "คัดลอกแล้ว ✓";
    setTimeout(() => $("copyBtn").textContent = "คัดลอกลิงก์", 1500);
  } catch {
    prompt("คัดลอกลิงก์นี้:", url);
  }
};

const params = new URLSearchParams(location.search);
const sharedRoom = params.get("room");
if (sharedRoom) {
  roomInput.value = sharedRoom;
}
