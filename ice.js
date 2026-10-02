// ผู้ให้บริการ ICE (STUN/TURN) — เลือกอัตโนมัติจาก environment variables
// ลำดับความสำคัญ: Cloudflare → Metered → coturn (shared secret) → TURN แบบ static → STUN อย่างเดียว
import crypto from "crypto";

const env = process.env;
const CRED_TTL = 24 * 60 * 60;      // อายุ credential ที่ขอจากผู้ให้บริการ (วินาที)
const CACHE_MS = 60 * 60 * 1000;    // cache ฝั่งเซิร์ฟเวอร์ 1 ชม. (ต่ำกว่า TTL มาก)
const RETRY_AFTER_FAIL_MS = 15_000;
const FETCH_TIMEOUT_MS = 8_000;

export const FALLBACK_ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
];

const splitList = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);

const normalize = list =>
  (Array.isArray(list) ? list : [])
    .map(s => ({ ...s, urls: [].concat(s.urls || []) }))
    .filter(s => s.urls.length > 0);

async function fromCloudflare() {
  const id = encodeURIComponent(env.CF_TURN_KEY_ID);
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ttl: CRED_TTL }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    }
  );
  if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);
  const data = await res.json();
  // พอร์ต 53 ถูกเบราว์เซอร์บล็อก ตัดออกเพื่อไม่ให้รอ timeout
  return normalize(data.iceServers).map(s => ({
    ...s,
    urls: s.urls.filter(u => !/:53(\?|$)/.test(u))
  }));
}

async function fromMetered() {
  const app = encodeURIComponent(env.METERED_APP_NAME);
  const key = encodeURIComponent(env.METERED_API_KEY);
  const region = env.METERED_REGION ? `&region=${encodeURIComponent(env.METERED_REGION)}` : "";
  const res = await fetch(
    `https://${app}.metered.live/api/v1/turn/credentials?apiKey=${key}${region}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Metered TURN responded ${res.status}`);
  return normalize(await res.json());
}

// coturn ที่เปิด use-auth-secret (TURN REST API) — สร้าง credential ชั่วคราวด้วย HMAC-SHA1
async function fromSecret() {
  const username = `${Math.floor(Date.now() / 1000) + CRED_TTL}:webcall`;
  const credential = crypto.createHmac("sha1", env.TURN_SECRET).update(username).digest("base64");
  return [
    ...FALLBACK_ICE,
    { urls: splitList(env.TURN_URLS), username, credential }
  ];
}

async function fromStatic() {
  return [
    ...FALLBACK_ICE,
    { urls: splitList(env.TURN_URLS), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }
  ];
}

const PROVIDERS = [
  { name: "cloudflare", ok: !!(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN), get: fromCloudflare },
  { name: "metered", ok: !!(env.METERED_APP_NAME && env.METERED_API_KEY), get: fromMetered },
  { name: "coturn-secret", ok: !!(env.TURN_URLS && env.TURN_SECRET), get: fromSecret },
  { name: "static-turn", ok: !!(env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL), get: fromStatic }
];

const active = PROVIDERS.find(p => p.ok);
export const iceMode = active ? active.name : "stun-only";

export function hasTurn(list) {
  return list.some(s => s.urls.some(u => /^turns?:/i.test(u)));
}

let cache = null;      // { list, until }
let failUntil = 0;
let inflight = null;

export async function getIceServers() {
  if (!active) return FALLBACK_ICE;
  if (cache && Date.now() < cache.until) return cache.list;
  if (Date.now() < failUntil) return cache?.list ?? FALLBACK_ICE;

  inflight ??= active.get()
    .then(list => {
      if (!list.length) throw new Error("empty ICE server list");
      cache = { list, until: Date.now() + CACHE_MS };
      return list;
    })
    .catch(err => {
      console.error(`[ice] ${active.name} failed:`, err.message);
      failUntil = Date.now() + RETRY_AFTER_FAIL_MS;
      return cache?.list ?? FALLBACK_ICE;
    })
    .finally(() => { inflight = null; });

  return inflight;
}
