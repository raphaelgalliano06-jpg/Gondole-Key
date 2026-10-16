'use strict';
/**
 * GONDOLE KEY — double authentification de Gondole One.
 * Serveur autonome, séparé du CRM. Aucune dépendance lourde.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

loadDotEnv(path.join(__dirname, '.env'));

const QRCode = require('qrcode');
const totp = require('./lib/totp');
const secure = require('./lib/secure');
const { Store, DEFAULT_SETTINGS } = require('./lib/store');

// ─── Configuration ───────────────────────────────────────────────────────────
const CONFIG = {
  port: Number(process.env.PORT) || 8080,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  period: Number(process.env.TOTP_PERIOD) || 17,
  digits: 6,
  window: 1,
  trustProxy: process.env.TRUST_PROXY !== '0',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  issuer: process.env.ISSUER || 'Gondole One',
};

secure.init(process.env.MASTER_KEY);
if (CONFIG.adminPassword.length < 12) {
  console.error('ADMIN_PASSWORD manquant ou trop court (12 caractères minimum).');
  process.exit(1);
}

const store = new Store(CONFIG.dataDir);
const S = () => store.data.settings;
const DAY = 86400000;

const adminSessions = new Map(); // jeton -> expiration
const adminLoginLimiter = new secure.RateLimiter(5, 15 * 60000);
const enrollLimiter = new secure.RateLimiter(20, 15 * 60000);
const apiLimiter = new secure.RateLimiter(600, 60000);

// ─── Utilitaires HTTP ────────────────────────────────────────────────────────
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}),
    ...(isSecure(res.req) ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    ...headers,
  });
  res.end(payload);
}

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Requête trop volumineuse'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON invalide'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (CONFIG.trustProxy && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

function isSecure(req) {
  if (!req) return false;
  if (CONFIG.trustProxy && req.headers['x-forwarded-proto']) return req.headers['x-forwarded-proto'].split(',')[0].trim() === 'https';
  return !!req.socket.encrypted;
}

function baseUrl(req) {
  if (CONFIG.publicUrl) return CONFIG.publicUrl;
  return `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });

// ─── Fichiers statiques ──────────────────────────────────────────────────────
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

function serveFile(res, rel, extraHeaders = {}) {
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Introuvable', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const ext = path.extname(file);
  send(res, 200, fs.readFileSync(file), {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' || rel === 'sw.js' ? 'no-cache' : 'public, max-age=3600',
    ...extraHeaders,
  });
}

// ─── Vues « propres » (jamais de secret ni de clé renvoyés) ───────────────────
function userStatus(u) {
  if (!u.active) return 'desactive';
  if (u.lockedUntil && u.lockedUntil > Date.now()) return 'bloque';
  if (!u.secretEnc) return 'en_attente';
  return 'actif';
}

function publicUser(u) {
  const trusts = Object.values(store.data.trust).filter((t) => t.userId === u.id && t.until > Date.now());
  return {
    id: u.id, login: u.login, name: u.name, email: u.email, active: u.active, status: userStatus(u),
    createdAt: u.createdAt, enrolledAt: u.enrolledAt || null, deviceLabel: u.deviceLabel || null,
    lastSuccessAt: u.lastSuccessAt || null, lockedUntil: u.lockedUntil || null,
    pendingEnrollment: Object.values(store.data.enrollments).some((e) => e.userId === u.id && e.expiresAt > Date.now()),
    trustedSessions: trusts.length,
  };
}

function publicTool(t) {
  return { id: t.id, name: t.name, active: t.active, keyPrefix: t.keyPrefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null };
}

// ─── Logique métier ──────────────────────────────────────────────────────────
function cleanLogin(v) {
  const l = String(v || '').trim().toLowerCase();
  if (!/^[a-z0-9._@+\-]{2,120}$/.test(l)) throw httpError(400, 'Identifiant invalide (lettres, chiffres, . _ @ + - uniquement).');
  return l;
}

function cleanText(v, max = 120) {
  return String(v || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function createUser({ login, name, email }) {
  const l = cleanLogin(login);
  if (store.userByLogin(l)) throw httpError(409, `L'identifiant « ${l} » existe déjà.`);
  const u = {
    id: secure.id(), login: l, name: cleanText(name) || l, email: cleanText(email, 160),
    active: true, createdAt: Date.now(), secretEnc: null, lastSteps: {}, failCount: 0, lockedUntil: 0,
  };
  store.data.users[u.id] = u;
  return u;
}

async function createEnrollment(u, req) {
  // Un seul lien valide à la fois par collaborateur.
  for (const [k, e] of Object.entries(store.data.enrollments)) if (e.userId === u.id) delete store.data.enrollments[k];
  const tok = secure.token(24);
  const expiresAt = Date.now() + S().enrollHours * 3600000;
  store.data.enrollments[secure.sha256(tok)] = { userId: u.id, expiresAt };
  const link = `${baseUrl(req)}/e/${tok}`;
  const qrSvg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  return { link, qrSvg, expiresAt };
}

function trustKey(userId, toolId, device) {
  return secure.sha256(`${userId}|${toolId}|${device}`);
}

function cleanDevice(v) {
  const d = String(v || '').trim();
  return /^[A-Za-z0-9_\-.:]{8,128}$/.test(d) ? d : null;
}

function verifyCode(u, tool, code, device) {
  const now = Date.now();
  if (!u.active) throw httpError(403, 'Compte désactivé.', { error: 'compte_desactive' });
  if (!u.secretEnc) throw httpError(409, "Double authentification pas encore activée pour ce collaborateur.", { error: 'non_active' });
  if (u.lockedUntil && u.lockedUntil > now) {
    throw httpError(423, 'Trop d\'erreurs. Compte bloqué temporairement.', { error: 'bloque', lockedUntil: u.lockedUntil });
  }

  const clean = String(code || '').replace(/\D/g, '');
  const step = clean.length === CONFIG.digits
    ? totp.match(secure.decrypt(u.secretEnc), clean, { period: CONFIG.period, digits: CONFIG.digits, window: CONFIG.window, now })
    : null;
  const last = (u.lastSteps || {})[tool.id] ?? -1;

  if (step === null || step <= last) {
    u.failCount = (u.failCount || 0) + 1;
    let remaining = S().maxAttempts - u.failCount;
    if (remaining <= 0) {
      u.lockedUntil = now + S().lockMinutes * 60000;
      u.failCount = 0;
      remaining = 0;
      store.log('blocage', { login: u.login, tool: tool.name });
    }
    store.log('code_refuse', { login: u.login, tool: tool.name, reason: step !== null ? 'deja_utilise' : 'invalide' });
    store.save();
    if (u.lockedUntil > now) throw httpError(423, 'Trop d\'erreurs. Compte bloqué temporairement.', { error: 'bloque', lockedUntil: u.lockedUntil });
    throw httpError(401, step !== null ? 'Ce code a déjà servi. Attends le suivant.' : 'Code incorrect.', { error: 'code_invalide', remaining });
  }

  u.lastSteps = { ...(u.lastSteps || {}), [tool.id]: step };
  u.failCount = 0;
  u.lockedUntil = 0;
  u.lastSuccessAt = now;
  let trustedUntil = null;
  if (device) {
    trustedUntil = now + S().trustDays * DAY;
    store.data.trust[trustKey(u.id, tool.id, device)] = { userId: u.id, toolId: tool.id, until: trustedUntil, at: now };
  }
  store.log('code_ok', { login: u.login, tool: tool.name });
  store.save();
  return { ok: true, trustedUntil };
}

// ─── Authentification ────────────────────────────────────────────────────────
function requireAdmin(req) {
  const tok = cookies(req).gk_admin;
  const exp = tok && adminSessions.get(secure.sha256(tok));
  if (!exp || exp < Date.now()) throw httpError(401, 'Session admin expirée. Reconnecte-toi.');
  // Protection CSRF : en-tête personnalisé obligatoire sur les écritures.
  if (req.method !== 'GET' && req.headers['x-gondole-key'] !== 'admin') throw httpError(403, 'Requête refusée.');
}

function requireTool(req) {
  const auth = String(req.headers.authorization || '');
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!key) throw httpError(401, 'Clé d\'outil manquante.');
  const h = secure.sha256(key);
  const tool = Object.values(store.data.tools).find((t) => secure.safeEqual(t.keyHash, h));
  if (!tool || !tool.active) throw httpError(401, 'Clé d\'outil invalide ou désactivée.');
  tool.lastUsedAt = Date.now();
  return tool;
}

function newToolKey(tool) {
  const key = `gk_${secure.token(30)}`;
  tool.keyHash = secure.sha256(key);
  tool.keyPrefix = key.slice(0, 9);
  return key;
}

// ─── Routes ──────────────────────────────────────────────────────────────────
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  // Pages
  if (m === 'GET') {
    if (p === '/' || p === '/app') return serveFile(res, 'app.html');
    if (p === '/admin') return serveFile(res, 'admin.html');
    if (/^\/e\/[A-Za-z0-9_-]{20,64}$/.test(p)) return serveFile(res, 'enroll.html');
    if (p === '/sw.js') return serveFile(res, 'sw.js', { 'Service-Worker-Allowed': '/' });
    if (p === '/manifest.webmanifest') return serveFile(res, 'manifest.webmanifest');
    if (p.startsWith('/assets/')) return serveFile(res, p.slice(8));
    if (p === '/sante') return send(res, 200, { ok: true });
    if (p === '/api/time') return send(res, 200, { now: Date.now(), period: CONFIG.period });
  }

  // ── Activation d'un téléphone ──
  if (m === 'POST' && p === '/api/enroll') {
    if (!enrollLimiter.hit(clientIp(req))) throw httpError(429, 'Trop de tentatives. Réessaie plus tard.');
    const body = await readJson(req);
    const h = secure.sha256(String(body.token || ''));
    const e = store.data.enrollments[h];
    if (!e || e.expiresAt < Date.now()) throw httpError(410, 'Ce lien a expiré ou a déjà servi. Demande un nouveau lien à ton responsable.');
    const u = store.data.users[e.userId];
    if (!u || !u.active) throw httpError(410, 'Ce compte n\'est plus actif.');
    const secret = totp.newSecret();
    u.secretEnc = secure.encrypt(secret);
    u.enrolledAt = Date.now();
    u.deviceLabel = cleanText(body.device, 80) || 'Téléphone';
    u.lastSteps = {};
    u.failCount = 0;
    u.lockedUntil = 0;
    delete store.data.enrollments[h];
    // Nouveau téléphone = on oublie les appareils de confiance précédents.
    for (const [k, t] of Object.entries(store.data.trust)) if (t.userId === u.id) delete store.data.trust[k];
    store.log('activation', { login: u.login, device: u.deviceLabel });
    store.save();
    return send(res, 200, {
      account: { login: u.login, name: u.name, issuer: CONFIG.issuer, secret: totp.base32Encode(secret), period: CONFIG.period, digits: CONFIG.digits, server: baseUrl(req) },
    });
  }

  // ── API pour Gondole One (serveur à serveur) ──
  if (p.startsWith('/api/v1/')) {
    if (!apiLimiter.hit(clientIp(req))) throw httpError(429, 'Trop de requêtes.');
    if (m !== 'POST') throw httpError(405, 'Méthode non autorisée.');
    const tool = requireTool(req);
    const body = await readJson(req);
    const u = store.userByLogin(body.login);
    const device = cleanDevice(body.device);

    if (p === '/api/v1/status') {
      if (!u) return send(res, 200, { known: false, required: false, enrolled: false, active: false });
      const t = device && store.data.trust[trustKey(u.id, tool.id, device)];
      const trusted = !!(t && t.until > Date.now());
      return send(res, 200, {
        known: true, active: u.active, enrolled: !!u.secretEnc, status: userStatus(u),
        required: u.active && !trusted, trustedUntil: trusted ? t.until : null, period: CONFIG.period,
      });
    }
    if (p === '/api/v1/verify') {
      if (!u) throw httpError(404, 'Collaborateur inconnu dans Gondole Key.', { error: 'inconnu' });
      return send(res, 200, verifyCode(u, tool, body.code, device));
    }
    if (p === '/api/v1/revoke') {
      if (!u) return send(res, 200, { ok: true });
      for (const [k, t] of Object.entries(store.data.trust)) {
        if (t.userId === u.id && t.toolId === tool.id && (!device || k === trustKey(u.id, tool.id, device))) delete store.data.trust[k];
      }
      store.save();
      return send(res, 200, { ok: true });
    }
    throw httpError(404, 'Route inconnue.');
  }

  // ── Espace admin ──
  if (p === '/admin/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (!adminLoginLimiter.hit(ip)) throw httpError(429, 'Trop de tentatives. Réessaie dans 15 minutes.');
    const body = await readJson(req);
    if (!secure.safeEqual(secure.sha256(body.password || ''), secure.sha256(CONFIG.adminPassword))) {
      store.log('admin_echec', { ip }); store.save();
      throw httpError(401, 'Mot de passe incorrect.');
    }
    adminLoginLimiter.reset(ip);
    const tok = secure.token(32);
    adminSessions.set(secure.sha256(tok), Date.now() + 8 * 3600000);
    store.log('admin_connexion', { ip }); store.save();
    const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${isSecure(req) ? '; Secure' : ''}`;
    return send(res, 200, { ok: true }, { 'Set-Cookie': `gk_admin=${tok}; ${flags}` });
  }

  if (p.startsWith('/admin/api/')) {
    if (p === '/admin/api/logout' && m === 'POST') {
      const tok = cookies(req).gk_admin;
      if (tok) adminSessions.delete(secure.sha256(tok));
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'gk_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
    }
    requireAdmin(req);
    const seg = p.slice('/admin/api/'.length).split('/');

    if (seg[0] === 'overview' && m === 'GET') {
      return send(res, 200, {
        users: Object.values(store.data.users).map(publicUser).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
        tools: Object.values(store.data.tools).map(publicTool),
        settings: S(), period: CONFIG.period, issuer: CONFIG.issuer,
      });
    }

    if (seg[0] === 'logs' && m === 'GET') {
      return send(res, 200, { logs: store.data.logs.slice(-300).reverse() });
    }

    if (seg[0] === 'settings' && m === 'PATCH') {
      const body = await readJson(req);
      const limits = { trustDays: [1, 90], maxAttempts: [3, 20], lockMinutes: [1, 1440], enrollHours: [1, 720] };
      for (const [k, [min, max]] of Object.entries(limits)) {
        if (body[k] !== undefined) {
          const v = Math.round(Number(body[k]));
          if (!Number.isFinite(v) || v < min || v > max) throw httpError(400, `Valeur hors limites pour ${k} (${min} à ${max}).`);
          S()[k] = v;
        }
      }
      store.log('reglages', { ...S() }); store.save();
      return send(res, 200, { settings: S() });
    }

    // Collaborateurs
    if (seg[0] === 'users') {
      if (seg.length === 1 && m === 'POST') {
        const body = await readJson(req);
        const u = createUser(body);
        const enrollment = await createEnrollment(u, req);
        store.log('creation', { login: u.login }); store.save();
        return send(res, 201, { user: publicUser(u), enrollment });
      }
      if (seg[1] === 'import' && m === 'POST') {
        const body = await readJson(req, 256 * 1024);
        const created = [], errors = [];
        String(body.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
          const [login, name, email] = line.split(/[;,\t]/).map((s) => s.trim());
          if (i === 0 && /identifiant|login/i.test(login)) return; // ligne d'en-tête
          try { created.push(createUser({ login, name, email })); }
          catch (e) { errors.push(`Ligne ${i + 1} : ${e.message}`); }
        });
        store.log('import', { count: created.length }); store.save();
        return send(res, 200, { created: created.length, errors });
      }
      const u = store.data.users[seg[1]];
      if (!u) throw httpError(404, 'Collaborateur introuvable.');
      if (seg.length === 2 && m === 'PATCH') {
        const body = await readJson(req);
        if (body.name !== undefined) u.name = cleanText(body.name) || u.login;
        if (body.email !== undefined) u.email = cleanText(body.email, 160);
        if (body.active !== undefined) {
          u.active = !!body.active;
          if (!u.active) for (const [k, t] of Object.entries(store.data.trust)) if (t.userId === u.id) delete store.data.trust[k];
        }
        store.log('modification', { login: u.login }); store.save();
        return send(res, 200, { user: publicUser(u) });
      }
      if (seg.length === 2 && m === 'DELETE') {
        delete store.data.users[u.id];
        for (const [k, t] of Object.entries(store.data.trust)) if (t.userId === u.id) delete store.data.trust[k];
        for (const [k, e] of Object.entries(store.data.enrollments)) if (e.userId === u.id) delete store.data.enrollments[k];
        store.log('suppression', { login: u.login }); store.save();
        return send(res, 200, { ok: true });
      }
      if (seg[2] === 'enroll' && m === 'POST') {
        const enrollment = await createEnrollment(u, req);
        store.log('lien_activation', { login: u.login }); store.save();
        return send(res, 200, { enrollment });
      }
      if (seg[2] === 'unlock' && m === 'POST') {
        u.lockedUntil = 0; u.failCount = 0;
        store.log('deblocage', { login: u.login }); store.save();
        return send(res, 200, { user: publicUser(u) });
      }
      if (seg[2] === 'reset-trust' && m === 'POST') {
        for (const [k, t] of Object.entries(store.data.trust)) if (t.userId === u.id) delete store.data.trust[k];
        store.log('reinit_confiance', { login: u.login }); store.save();
        return send(res, 200, { user: publicUser(u) });
      }
    }

    // Outils reliés
    if (seg[0] === 'tools') {
      if (seg.length === 1 && m === 'POST') {
        const body = await readJson(req);
        const name = cleanText(body.name, 60);
        if (!name) throw httpError(400, 'Donne un nom à l\'outil.');
        if (Object.values(store.data.tools).some((t) => t.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'Un outil porte déjà ce nom.');
        const tool = { id: secure.id(), name, active: true, createdAt: Date.now() };
        const apiKey = newToolKey(tool);
        store.data.tools[tool.id] = tool;
        store.log('outil_cree', { tool: name }); store.save();
        return send(res, 201, { tool: publicTool(tool), apiKey });
      }
      const tool = store.data.tools[seg[1]];
      if (!tool) throw httpError(404, 'Outil introuvable.');
      if (seg[2] === 'rotate' && m === 'POST') {
        const apiKey = newToolKey(tool);
        store.log('outil_nouvelle_cle', { tool: tool.name }); store.save();
        return send(res, 200, { tool: publicTool(tool), apiKey });
      }
      if (seg.length === 2 && m === 'PATCH') {
        const body = await readJson(req);
        if (body.active !== undefined) tool.active = !!body.active;
        if (body.name) tool.name = cleanText(body.name, 60);
        store.save();
        return send(res, 200, { tool: publicTool(tool) });
      }
      if (seg.length === 2 && m === 'DELETE') {
        delete store.data.tools[tool.id];
        for (const [k, t] of Object.entries(store.data.trust)) if (t.toolId === tool.id) delete store.data.trust[k];
        store.log('outil_supprime', { tool: tool.name }); store.save();
        return send(res, 200, { ok: true });
      }
    }
    throw httpError(404, 'Route inconnue.');
  }

  throw httpError(404, 'Introuvable.');
}

// ─── Démarrage ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { ok: false, message: status === 500 ? 'Erreur interne.' : err.message, ...(err.extra || {}) });
  });
});

setInterval(() => {
  store.purge();
  const now = Date.now();
  for (const [k, exp] of adminSessions) if (exp < now) adminSessions.delete(k);
}, 10 * 60000).unref();

server.listen(CONFIG.port, () => {
  console.log(`GONDOLE KEY prêt sur le port ${CONFIG.port} — codes de ${CONFIG.period} s, données dans ${CONFIG.dataDir}`);
});

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (mm && process.env[mm[1]] === undefined) process.env[mm[1]] = mm[2].replace(/^["']|["']$/g, '');
  }
}

module.exports = { server, DEFAULT_SETTINGS };
