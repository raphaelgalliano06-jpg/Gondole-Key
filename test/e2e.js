'use strict';
/* Test complet : admin → collaborateur → activation téléphone → code → Gondole One. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const totp = require('../lib/totp');
const { GondoleKey } = require('../integration/gondole-key-client');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-test-'));
const ADMIN = 'mot-de-passe-admin-test';
let ok = 0;
const etape = (t) => { ok++; console.log(`  ✓ ${t}`); };

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: DATA, MASTER_KEY: 'x'.repeat(40), ADMIN_PASSWORD: ADMIN, PUBLIC_URL: BASE, TOTP_PERIOD: '17' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => srv.stdout.once('data', r));
  try { await scenario(); } finally { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); }
  console.log(`\n${ok} vérifications réussies.`);
}

let cookie = '';
async function admin(chemin, method = 'GET', body) {
  const r = await fetch(`${BASE}/admin/api/${chemin}`, { method, headers: { 'Content-Type': 'application/json', 'X-Gondole-Key': 'admin', Cookie: cookie }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, ...(await r.json()) };
}
const post = async (url, body, headers = {}) => { const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };

async function scenario() {
  // Admin
  assert.equal((await admin('overview')).status, 401); etape('admin protégé sans connexion');
  assert.equal((await admin('login', 'POST', { password: 'faux' })).status, 401); etape('mauvais mot de passe admin refusé');
  assert.equal((await admin('login', 'POST', { password: ADMIN })).status, 200); etape('connexion admin');
  const sansCsrf = await fetch(`${BASE}/admin/api/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
  assert.equal(sansCsrf.status, 403); etape('protection CSRF active');

  // Outil + collaborateur
  const outil = await admin('tools', 'POST', { name: 'Gondole One — CRM' });
  assert.ok(outil.apiKey.startsWith('gk_')); etape('outil relié, clé fournie une seule fois');
  const outil2 = await admin('tools', 'POST', { name: 'Gondole One — Notes de frais' });
  const cree = await admin('users', 'POST', { login: 'J.Dupont@cpm.fr', name: 'Jean Dupont', email: 'j.dupont@cpm.fr' });
  assert.equal(cree.status, 201); assert.equal(cree.user.status, 'en_attente'); assert.ok(cree.enrollment.qrSvg.includes('<svg')); etape('collaborateur créé avec lien + QR');
  assert.equal((await admin('users', 'POST', { login: 'j.dupont@cpm.fr' })).status, 409); etape('doublon refusé');
  const imp = await admin('users/import', 'POST', { text: 'identifiant;nom;email\nmmartin;Marie Martin;m@x.fr\nbad login!;X;\npdurand;Paul Durand;' });
  assert.equal(imp.created, 2); assert.equal(imp.errors.length, 1); etape('import de liste (2 ajoutés, 1 ligne rejetée)');

  const key = new GondoleKey({ url: BASE, apiKey: outil.apiKey });
  const keyNdf = new GondoleKey({ url: BASE, apiKey: outil2.apiKey });
  const pc = GondoleKey.nouvel_appareil();

  let d = await key.faut_il_demander('j.dupont@cpm.fr', pc);
  assert.equal(d.raison, 'pas_encore_active'); etape('avant activation : pas de code demandé (mode déploiement)');
  const strict = new GondoleKey({ url: BASE, apiKey: outil.apiKey, obligatoire: true });
  assert.equal((await strict.faut_il_demander('j.dupont@cpm.fr', pc)).bloquer, true); etape('mode obligatoire : accès bloqué tant que non activé');

  // Activation du téléphone
  const jeton = cree.enrollment.link.split('/e/')[1];
  assert.equal((await fetch(`${BASE}/e/${jeton}`)).status, 200); etape('page d\'activation accessible');
  const act = await post('/api/enroll', { token: jeton, device: 'iPhone' });
  assert.equal(act.status, 200); assert.equal(act.account.period, 17); etape('téléphone activé, codes de 17 s');
  assert.equal((await post('/api/enroll', { token: jeton })).status, 410); etape('lien d\'activation à usage unique');
  const secret = totp.base32Decode(act.account.secret);

  const brut = JSON.parse(fs.readFileSync(path.join(DATA, 'gondole-key.json'), 'utf8'));
  assert.ok(!JSON.stringify(brut).includes(act.account.secret)); assert.ok(!JSON.stringify(brut).includes(outil.apiKey)); etape('secrets et clés chiffrés/hachés sur disque');

  // Connexion Gondole One
  d = await key.faut_il_demander('j.dupont@cpm.fr', pc);
  assert.equal(d.demander, true); etape('code demandé sur un nouvel appareil');
  assert.equal((await key.verifier('j.dupont@cpm.fr', '000000', pc)).ok, false); etape('mauvais code refusé');
  const bon = totp.generate(secret, { period: 17 });
  const v = await key.verifier('j.dupont@cpm.fr', bon, pc);
  assert.equal(v.ok, true); assert.ok(v.confianceJusqua > Date.now() + 6.9 * 86400000); etape('bon code accepté, appareil de confiance 7 jours');
  assert.equal((await key.verifier('j.dupont@cpm.fr', bon, pc)).ok, false); etape('même code impossible à réutiliser');
  assert.equal((await key.faut_il_demander('j.dupont@cpm.fr', pc)).demander, false); etape('plus de code demandé sur cet appareil cette semaine');
  assert.equal((await keyNdf.faut_il_demander('j.dupont@cpm.fr', pc)).demander, true); etape('un autre outil redemande son propre code');
  assert.equal((await key.faut_il_demander('j.dupont@cpm.fr', GondoleKey.nouvel_appareil())).demander, true); etape('un autre appareil redemande le code');

  // Code de la période précédente (décalage d'horloge toléré)
  const prec = totp.generate(secret, { period: 17, now: Date.now() - 17000 });
  assert.equal((await keyNdf.verifier('j.dupont@cpm.fr', prec, pc)).ok, true); etape('léger décalage d\'horloge toléré');
  const vieux = totp.generate(secret, { period: 17, now: Date.now() - 60000 });
  assert.equal((await keyNdf.verifier('j.dupont@cpm.fr', vieux, GondoleKey.nouvel_appareil())).ok, false); etape('code de plus d\'une minute refusé');

  // Blocage après 5 erreurs
  const tel2 = GondoleKey.nouvel_appareil();
  let r; for (let i = 0; i < 5; i++) r = await key.verifier('j.dupont@cpm.fr', '111111', tel2);
  assert.ok(r.bloqueJusqua > Date.now()); etape('blocage après 5 erreurs');
  assert.equal((await key.verifier('j.dupont@cpm.fr', totp.generate(secret, { period: 17, now: Date.now() + 17000 }), tel2)).ok, false); etape('même un bon code est refusé pendant le blocage');
  const ov = await admin('overview');
  const jd = ov.users.find((u) => u.login === 'j.dupont@cpm.fr');
  assert.equal(jd.status, 'bloque');
  await admin(`users/${jd.id}/unlock`, 'POST'); etape('déblocage par l\'admin');

  // Réinitialiser / désactiver
  await admin(`users/${jd.id}/reset-trust`, 'POST');
  assert.equal((await key.faut_il_demander('j.dupont@cpm.fr', pc)).demander, true); etape('« Redemander le code » oblige à le ressaisir');
  await admin(`users/${jd.id}`, 'PATCH', { active: false });
  assert.equal((await key.faut_il_demander('j.dupont@cpm.fr', pc)).bloquer, true); etape('collaborateur désactivé = accès refusé');

  // Clé d'outil
  const rot = await admin(`tools/${outil.tool.id}/rotate`, 'POST');
  const ancien = await post('/api/v1/status', { login: 'x' }, { Authorization: `Bearer ${outil.apiKey}` });
  assert.equal(ancien.status, 401); etape('ancienne clé d\'outil refusée après renouvellement');
  const nouveau = await post('/api/v1/status', { login: 'x' }, { Authorization: `Bearer ${rot.apiKey}` });
  assert.equal(nouveau.status, 200); etape('nouvelle clé acceptée');

  // Réglages
  assert.equal((await admin('settings', 'PATCH', { trustDays: 999 })).status, 400);
  assert.equal((await admin('settings', 'PATCH', { trustDays: 14 })).settings.trustDays, 14); etape('réglages modifiables avec garde-fous');
  assert.ok((await admin('logs')).logs.length > 10); etape('journal alimenté');
}

main().catch((e) => { console.error('\n✗ ÉCHEC :', e); process.exit(1); });
