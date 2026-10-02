import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { getIceServers, hasTurn, iceMode } from "./ice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MAX_PEERS = 2;
const ROOM_RE = /^[A-Z0-9_-]{3,40}$/;
const RELAY_TYPES = new Set(["offer", "answer", "ice-candidate"]);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Render อยู่หลัง proxy

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "microphone=(self)");
  next();
});

// ---- rate limit แบบเบา ๆ (กันคนยิง /api/ice รัวเพื่อเปลือง quota TURN) ----
const hits = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const rec = hits.get(req.ip);
    if (!rec || now > rec.reset) {
      hits.set(req.ip, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++rec.count > limit) return res.status(429).json({ error: "too_many_requests" });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60_000).unref();

app.get("/health", (_req, res) => res.json({ ok: true, ice: iceMode }));

app.get("/api/ice", rateLimit(30, 60_000), async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const iceServers = await getIceServers();
  res.json({ iceServers, hasTurn: hasTurn(iceServers) });
});

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
// Render/proxy ปิด connection ที่ idle — ตั้งให้นานกว่า idle timeout ของ load balancer
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;

// ---- WebSocket signaling ----
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!origin) return true; // client ที่ไม่ใช่เบราว์เซอร์
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
});

const rooms = new Map(); // roomId -> Set<ws>

const send = (ws, data) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
};

function leave(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  ws.roomId = null;
  const room = rooms.get(roomId);
  if (!room || !room.delete(ws)) return;
  for (const peer of room) send(peer, { type: "peer-left" });
  if (room.size === 0) rooms.delete(roomId);
}

function join(ws, msg) {
  const roomId = String(msg.roomId || "").trim().toUpperCase();
  if (!ROOM_RE.test(roomId)) return send(ws, { type: "error", message: "รหัสห้องไม่ถูกต้อง" });

  if (ws.roomId) leave(ws);

  let room = rooms.get(roomId);
  if (!room) { room = new Set(); rooms.set(roomId, room); }

  // ถ้า client เดิม (clientId เดียวกัน) ต่อกลับมาใหม่ ให้แทนที่ socket เก่าที่อาจค้างอยู่
  if (ws.clientId) {
    for (const old of [...room]) {
      if (old.clientId === ws.clientId) {
        room.delete(old);
        old.roomId = null;
        old.terminate();
      }
    }
  }

  if (room.size >= MAX_PEERS) {
    if (room.size === 0) rooms.delete(roomId);
    return send(ws, { type: "full" });
  }

  const peers = room.size;
  ws.roomId = roomId;
  room.add(ws);
  send(ws, { type: "joined", roomId, peers });
  // คนที่อยู่ในห้องก่อนเป็นฝ่ายสร้าง offer
  for (const peer of room) if (peer !== ws) send(peer, { type: "peer-joined" });
}

wss.on("connection", ws => {
  ws.roomId = null;
  ws.clientId = null;
  ws.isAlive = true;
  ws.msgCount = 0;

  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", () => {});

  ws.on("message", raw => {
    if (++ws.msgCount > 300) return ws.close(1008, "rate limit"); // 300 ข้อความ / 10 วินาที
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "join") {
      ws.clientId = typeof msg.clientId === "string" ? msg.clientId.slice(0, 64) : null;
      return join(ws, msg);
    }

    if (!RELAY_TYPES.has(msg.type) || !ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    for (const peer of room) if (peer !== ws) send(peer, msg);
  });

  ws.on("close", () => leave(ws));
});

// ping ทุก 25 วินาที: ทั้งกันโดนตัดเพราะ idle และเก็บกวาด socket ที่ตายไปแล้ว
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);
const resetCounters = setInterval(() => {
  for (const ws of wss.clients) ws.msgCount = 0;
}, 10_000);
wss.on("close", () => { clearInterval(heartbeat); clearInterval(resetCounters); });

// Render ส่ง SIGTERM ตอน deploy — ปิดอย่างสุภาพ (client จะ reconnect เอง)
function shutdown() {
  for (const ws of wss.clients) ws.close(1012, "server restart");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Web Call running on port ${PORT} (ICE mode: ${iceMode})`);
});
