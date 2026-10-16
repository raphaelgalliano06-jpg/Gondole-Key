'use strict';
/* GONDOLE KEY — appli collaborateur : calcule le code sur le téléphone, sans réseau. */
(function () {
  const CLE = 'gk.comptes';
  const CLE_DECALAGE = 'gk.decalage';
  const CIRCONF = 2 * Math.PI * 118;

  const lire = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

  let decalage = Number(lire(CLE_DECALAGE, 0)) || 0; // écart horloge téléphone / serveur (ms)
  const maintenant = () => Date.now() + decalage;

  // ── Calcul du code (norme TOTP) ──
  function base32(str) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, val = 0; const out = [];
    for (const c of str.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
      val = (val << 5) | A.indexOf(c); bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }
  const cles = new Map();
  async function code(compte, pas) {
    let k = cles.get(compte.secret);
    if (!k) {
      k = await crypto.subtle.importKey('raw', base32(compte.secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
      cles.set(compte.secret, k);
    }
    const msg = new ArrayBuffer(8);
    new DataView(msg).setUint32(4, pas >>> 0);
    new DataView(msg).setUint32(0, Math.floor(pas / 2 ** 32));
    const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
    const o = h[h.length - 1] & 15;
    const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 10 ** compte.digits).padStart(compte.digits, '0');
  }
  const joli = (c) => c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;

  // ── Affichage ──
  const zone = document.getElementById('comptes');
  const modele = document.getElementById('modele-compte');
  let cartes = [];

  function afficher() {
    const comptes = lire(CLE, []);
    zone.innerHTML = '';
    cartes = [];
    document.getElementById('vide').classList.toggle('cache', comptes.length > 0);
    comptes.forEach((c, i) => {
      const n = modele.content.firstElementChild.cloneNode(true);
      n.querySelector('.nom').textContent = c.name;
      n.querySelector('.ident').textContent = `Identifiant : ${c.login} — activé le ${new Date(c.addedAt).toLocaleDateString('fr-FR')}`;
      const cadran = n.querySelector('.cadran');
      const carte = { c, cadran, codeEl: n.querySelector('.code'), sec: n.querySelector('.secondes'), anneau: n.querySelector('.anneau'), pas: -1, valeur: '', copieJusqua: 0 };
      cadran.addEventListener('click', () => copier(carte));
      n.querySelector('.retirer').addEventListener('click', () => {
        if (!confirm(`Retirer le compte de ${c.name} de ce téléphone ? Il faudra un nouveau lien d'activation.`)) return;
        const reste = lire(CLE, []); reste.splice(i, 1); ecrire(CLE, reste); afficher();
      });
      zone.appendChild(n);
      cartes.push(carte);
    });
    tic();
  }

  async function copier(carte) {
    if (!carte.valeur) return;
    try {
      await navigator.clipboard.writeText(carte.valeur);
      carte.copieJusqua = Date.now() + 1500;
      tic();
    } catch { /* copie refusée par le navigateur : le code reste lisible */ }
  }

  async function tic() {
    const t = maintenant();
    for (const k of cartes) {
      const periode = k.c.period;
      const pas = Math.floor(t / 1000 / periode);
      const restant = periode - ((t / 1000) % periode);
      if (pas !== k.pas) {
        k.pas = pas;
        k.valeur = await code(k.c, pas);
        k.codeEl.textContent = joli(k.valeur);
        // Remet l'anneau plein sans animation, puis repart.
        k.anneau.style.transition = 'none';
        k.anneau.style.strokeDashoffset = String(CIRCONF * (1 - restant / periode));
        k.anneau.getBoundingClientRect();
        k.anneau.style.transition = '';
      }
      k.anneau.style.strokeDashoffset = String(CIRCONF * (1 - Math.max(0, restant - 1) / periode));
      const copie = k.copieJusqua > Date.now();
      k.cadran.classList.toggle('copie', copie);
      k.cadran.classList.toggle('fin', !copie && restant <= 5);
      k.sec.textContent = copie ? 'Copié' : `${Math.ceil(restant)} s`;
    }
  }

  // Cale l'affichage sur la seconde pleine.
  function boucle() {
    tic();
    setTimeout(boucle, 1000 - (maintenant() % 1000) + 5);
  }

  // ── Correction automatique de l'heure ──
  async function synchroniser() {
    try {
      const t0 = Date.now();
      const r = await fetch('/api/time', { cache: 'no-store' });
      const t1 = Date.now();
      const { now } = await r.json();
      const d = now - (t0 + t1) / 2;
      decalage = Math.abs(d) > 1500 ? Math.round(d) : 0;
      ecrire(CLE_DECALAGE, decalage);
      document.getElementById('horloge').classList.toggle('cache', decalage === 0);
      cartes.forEach((k) => { k.pas = -1; });
      tic();
    } catch { /* hors ligne : on garde le dernier décalage connu */ }
  }

  const autonome = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!autonome && lire(CLE, []).length) document.getElementById('installer').classList.remove('cache');

  afficher();
  boucle();
  synchroniser();
  setInterval(synchroniser, 10 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { synchroniser(); tic(); } });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
