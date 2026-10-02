# Web Call — 1-to-1 WebRTC Voice Call

เว็บโทรเสียง 1 ต่อ 1 ผ่านเบราว์เซอร์ ใช้ WebRTC + WebSocket signaling

## ต้องมี
- Node.js 20+
- GitHub Codespaces หรือเครื่องที่รัน Node.js ได้

## รันใน Codespaces

```bash
npm install
npm start
```

จากนั้นเปิดแท็บ **PORTS** ของ Codespaces และเปิดพอร์ต 3000 เป็น **Public** หากต้องการให้อีกคนเข้าจากอินเทอร์เน็ต

## วิธีทดสอบ

1. เปิดเว็บบนอุปกรณ์ A
2. กด `สร้างห้องโทร`
3. กด `คัดลอกลิงก์`
4. ส่งลิงก์ให้อุปกรณ์ B
5. อุปกรณ์ B เปิดลิงก์และอนุญาต Microphone
6. ระบบจะเชื่อมเสียงผ่าน WebRTC

## หมายเหตุสำคัญ

โปรเจกต์เริ่มต้นนี้ใช้ STUN อย่างเดียว จึงเหมาะกับการทดลองและเครือข่ายทั่วไป แต่บางเครือข่าย/NAT/firewall อาจเชื่อมต่อไม่ได้

สำหรับ production ควรเพิ่ม TURN server เพื่อให้การเชื่อมต่อเสถียรขึ้น เช่น coturn หรือผู้ให้บริการ TURN

## โครงสร้าง

- `server.js` — Express + WebSocket signaling
- `public/index.html` — หน้าเว็บ
- `public/css/style.css` — UI
- `public/js/app.js` — WebRTC/client logic
