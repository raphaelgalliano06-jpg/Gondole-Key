'use strict';
/**
 * Codes temporaires (norme TOTP, RFC 6238) — période réglable (17 s par défaut).
 */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

function stepAt(now, period) {
  return Math.floor(now / 1000 / period);
}

function generate(secret, { period = 17, digits = 6, now = Date.now() } = {}) {
  return hotp(secret, stepAt(now, period), digits);
}

/**
 * Vérifie un code. Accepte le pas courant et ±window pas (décalage d'horloge).
 * Renvoie le numéro de pas reconnu, ou null.
 */
function match(secret, code, { period = 17, digits = 6, window = 1, now = Date.now() } = {}) {
  const given = Buffer.from(String(code));
  if (given.length !== digits) return null;
  const current = stepAt(now, period);
  let found = null;
  // On parcourt toujours toutes les fenêtres (temps constant).
  for (let s = current - window; s <= current + window; s++) {
    const expected = Buffer.from(hotp(secret, s, digits));
    if (crypto.timingSafeEqual(expected, given) && found === null) found = s;
  }
  return found;
}

function newSecret() {
  return crypto.randomBytes(20); // 160 bits, recommandé par la norme
}

module.exports = { base32Encode, base32Decode, hotp, generate, match, stepAt, newSecret };
