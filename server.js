import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static("public"));

const rooms = new Map();

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

function roomPeers(roomId) {
  const room = rooms.get(roomId);
  return room ? [...room].filter(ws => ws.readyState === ws.OPEN) : [];
}

wss.on("connection", ws => {
  ws.id = crypto.randomUUID();
  ws.roomId = null;

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "").trim().slice(0, 80);
      if (!roomId) return send(ws, { type: "error", message: "Invalid room." });

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const room = rooms.get(roomId);

      if (room.size >= 2 && !room.has(ws)) {
        return send(ws, { type: "full" });
      }

      ws.roomId = roomId;
      const wasEmpty = room.size === 0;
      room.add(ws);

      send(ws, {
        type: "joined",
        roomId,
        initiator: wasEmpty,
        peerCount: room.size
      });

      for (const peer of room) {
        if (peer !== ws) send(peer, { type: "peer-joined" });
      }
      return;
    }

    if (!ws.roomId) return;

    const room = rooms.get(ws.roomId);
    if (!room) return;

    if (["offer", "answer", "ice-candidate"].includes(msg.type)) {
      for (const peer of room) {
        if (peer !== ws) send(peer, msg);
      }
    }
  });

  ws.on("close", () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    room.delete(ws);
    for (const peer of room) send(peer, { type: "peer-left" });
    if (room.size === 0) rooms.delete(ws.roomId);
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Web Call running on port ${PORT}`);
});
