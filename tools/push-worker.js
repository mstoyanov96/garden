/* =========================================================================
   push-worker.js — Cloudflare Worker за истински push известия (БЕЗ карта)
   -------------------------------------------------------------------------
   Какво прави: получава POST заявка от приложението със списък абонаменти и
   текст, после праща криптирано Web Push съобщение към всеки телефон. Работи,
   дори когато приложението на получателя е напълно затворено.

   Няма нужда от външни библиотеки, нито от build стъпка — целият Web Push
   (криптиране aes128gcm по RFC 8291 + VAPID по RFC 8292) е реализиран тук с
   вградения Web Crypto на Cloudflare. Просто копирай целия файл в редактора на
   Cloudflare Worker и го деплойни.

   ВАЖНО: VAPID_PRIVATE е ТАЕН ключ. Този файл живее само в Cloudflare (сървър),
   НЕ го качвай публично (напр. в GitHub Pages). Публичният ключ (VAPID_PUBLIC)
   може да е публичен и вече е сложен в app/js/firebase-config.js.
   ========================================================================= */

// --- VAPID ключове (генерирани за това приложение) -----------------------
const VAPID_PUBLIC = 'BNX7CzPYZQjmm1pbxVH3FR1LYZjCbfXByPU6JFwCI4oBrZWfuyPkWSrcDa6n229COv1XVv89ZvzanEsydvwfpnA';
const VAPID_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: '1fsLM9hlCOabWlvFUfcVHUthmMJt9cHI9TokXAIjigE',
  y: 'rZWfuyPkWSrcDa6n229COv1XVv89ZvzanEsydvwfpnA',
  d: 'iAK6g_UTWJeNuzHo840nab-xdnvrBKbmOh5ytZ65ldU'
};
// Контактен адрес за push услугите (може да е твоят e-mail).
const VAPID_SUBJECT = 'mailto:orehova.gradina@example.com';

// --- помощни функции -----------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function utf8(s) { return new TextEncoder().encode(s); }
function concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const raw = atob(s + pad), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// VAPID Authorization хедър за дадено push endpoint
async function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => bytesToB64url(utf8(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: now + 12 * 3600, sub: VAPID_SUBJECT });
  const key = await crypto.subtle.importKey('jwk', VAPID_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(unsigned));
  const jwt = unsigned + '.' + bytesToB64url(new Uint8Array(sig));
  return 'vapid t=' + jwt + ', k=' + VAPID_PUBLIC;
}

// Криптира payload-а за дадения абонамент (Content-Encoding: aes128gcm)
async function encryptPayload(payloadBytes, p256dhB64, authB64) {
  const uaPublic = b64urlToBytes(p256dhB64);   // публичният ключ на телефона (65 байта)
  const authSecret = b64urlToBytes(authB64);   // auth таен (16 байта)

  // ефемерна ECDH двойка на сървъра
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 байта

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const record = concat(payloadBytes, new Uint8Array([2])); // 0x02 = край на единствения запис
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  const rs = 4096;
  const header = concat(
    salt,
    new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]),
    new Uint8Array([asPublic.length]),
    asPublic
  );
  return concat(header, ct);
}

async function sendOne(sub, payloadObj) {
  if (!sub || !sub.endpoint || !sub.keys) return 'skip';
  const body = await encryptPayload(utf8(JSON.stringify(payloadObj)), sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Authorization': await vapidAuth(sub.endpoint)
    },
    body
  });
  return res.status;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Push worker OK', { headers: CORS });

    let data;
    try { data = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }

    const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    const payload = {
      title: data.title || 'Орехова градина',
      body: data.body || '',
      tag: data.tag || undefined,
      url: data.url || './',
      icon: 'assets/icon.svg'
    };

    const results = await Promise.all(subs.map(async (s) => {
      try { return await sendOne(s, payload); }
      catch (e) { return 'err:' + (e && e.message ? e.message : 'unknown'); }
    }));

    return json({ sent: results.length, results });
  }
};
