'use strict';
(function () {
  const CLE = 'gk.comptes';
  const lire = () => { try { return JSON.parse(localStorage.getItem(CLE) || '[]'); } catch { return []; } };
  const jeton = location.pathname.split('/').pop();
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const autonome = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  // Déjà activé avec ce lien (icône iPhone relancée) : on va directement aux codes.
  if (localStorage.getItem('gk.lien.' + jeton)) { location.replace('/app'); return; }

  const bouton = document.getElementById('activer');
  const ici = document.getElementById('ici');
  const erreur = document.getElementById('erreur');

  if (ios && !autonome) {
    document.getElementById('ios').classList.remove('cache');
    bouton.classList.add('cache');
    ici.classList.remove('cache');
  }

  async function activer(btn) {
    btn.disabled = true;
    erreur.classList.add('cache');
    try {
      const r = await fetch('/api/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: jeton, device: ios ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Navigateur' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Activation impossible.');
      const a = d.account;
      const comptes = lire().filter((c) => !(c.login === a.login && c.server === a.server));
      comptes.push({ ...a, addedAt: Date.now() });
      localStorage.setItem(CLE, JSON.stringify(comptes));
      localStorage.setItem('gk.lien.' + jeton, '1');
      location.replace('/app');
    } catch (e) {
      erreur.textContent = e.message === 'Failed to fetch' ? 'Pas de connexion. Vérifie le réseau et réessaie.' : e.message;
      erreur.classList.remove('cache');
      btn.disabled = false;
    }
  }

  bouton.addEventListener('click', () => activer(bouton));
  ici.addEventListener('click', () => activer(ici));
})();
