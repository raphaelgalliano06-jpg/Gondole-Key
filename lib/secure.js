'use strict';
/**
 * Chiffrement des secrets au repos (AES-256-GCM) et petits outils de sécurité.
 */
const crypto = require('crypto');

let KEY = null;

function init(masterKey) {
  if (!masterKey || String(masterKey).length < 32) {
    throw new Error('MASTER_KEY manquante ou trop courte (32 caractères minimum). Lance « npm run cles ».');
  }
  KEY = crypto.createHash('sha256').update(String(masterKey)).digest();
}

function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(str) {
  const [v, iv, tag, enc] = String(str).split('.');
  if (v !== 'v1') throw new Error('Format de secret inconnu');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const id = () => crypto.randomBytes(8).toString('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/** Limiteur simple : n essais par fenêtre, par clé (IP, identifiant…). */
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max; this.windowMs = windowMs; this.hits = new Map();
  }
  hit(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset < now) { e = { n: 0, reset: now + this.windowMs }; this.hits.set(key, e); }
    e.n++;
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    return e.n <= this.max;
  }
  reset(key) { this.hits.delete(key); }
}

module.exports = { init, encrypt, decrypt, sha256, token, id, safeEqual, RateLimiter };
