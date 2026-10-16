'use strict';
/* GONDOLE KEY — espace admin */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const date = (t) => t ? new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const ETATS = { actif: 'Activé', en_attente: 'En attente d\'activation', bloque: 'Bloqué', desactive: 'Désactivé' };
  let donnees = { users: [], tools: [], settings: {} };

  async function api(chemin, options = {}) {
    const r = await fetch('/admin/api/' + chemin, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Gondole-Key': 'admin' },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && chemin !== 'login') { montrerConnexion(); throw new Error(d.message); }
    if (!r.ok) throw new Error(d.message || 'Erreur');
    return d;
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.remove('cache');
    clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('cache'), 2600);
  }

  async function copier(texte, msg) {
    try { await navigator.clipboard.writeText(texte); toast(msg); } catch { toast('Copie impossible : sélectionne le texte et copie-le.'); }
  }

  // ── Connexion ──
  function montrerConnexion() { $('ecran-admin').classList.add('cache'); $('ecran-connexion').classList.remove('cache'); $('mdp').focus(); }
  function montrerAdmin() { $('ecran-connexion').classList.add('cache'); $('ecran-admin').classList.remove('cache'); }

  $('form-connexion').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('erreur-connexion').classList.add('cache');
    try {
      await api('login', { method: 'POST', body: { password: $('mdp').value } });
      $('mdp').value = '';
      montrerAdmin(); charger();
    } catch (err) {
      $('erreur-connexion').textContent = err.message;
      $('erreur-connexion').classList.remove('cache');
    }
  });
  $('deconnexion').addEventListener('click', async () => { await api('logout', { method: 'POST' }).catch(() => {}); montrerConnexion(); });

  // ── Onglets ──
  document.querySelectorAll('[data-onglet]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-onglet]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.panneau').forEach((p) => p.classList.toggle('cache', p.id !== b.dataset.onglet));
    if (b.dataset.onglet === 'journal') chargerJournal();
  }));

  // ── Chargement ──
  async function charger() {
    donnees = await api('overview');
    rendreCollab(); rendreOutils(); rendreReglages();
  }

  function rendreCollab() {
    const u = donnees.users;
    const n = (s) => u.filter((x) => x.status === s).length;
    $('synthese').innerHTML = `
      <div class="chiffre"><strong>${u.length}</strong><span>collaborateurs</span></div>
      <div class="chiffre bleu"><strong>${n('actif')}</strong><span>téléphones activés</span></div>
      <div class="chiffre"><strong>${n('en_attente')}</strong><span>en attente d'activation</span></div>
      <div class="chiffre ${n('bloque') ? 'ambre' : ''}"><strong>${n('bloque')}</strong><span>bloqués</span></div>`;

    const q = $('recherche').value.trim().toLowerCase();
    const liste = u.filter((x) => !q || `${x.name} ${x.login} ${x.email}`.toLowerCase().includes(q));
    $('vide-collab').classList.toggle('cache', u.length > 0);
    $('liste-collab').innerHTML = liste.map((x) => `
      <tr data-id="${esc(x.id)}">
        <td class="qui"><strong>${esc(x.name)}</strong><span>${esc(x.login)}${x.email ? ' — ' + esc(x.email) : ''}</span></td>
        <td><span class="etat ${esc(x.status)}">${ETATS[x.status]}</span></td>
        <td>${x.deviceLabel ? esc(x.deviceLabel) + '<br><span class="doux">depuis le ' + new Date(x.enrolledAt).toLocaleDateString('fr-FR') + '</span>' : '<span class="doux">—</span>'}</td>
        <td>${date(x.lastSuccessAt)}</td>
        <td class="droite">
          ${x.status === 'bloque' ? '<button class="btn petit" data-act="unlock">Débloquer</button>' : ''}
          ${x.active ? `<button class="btn secondaire petit" data-act="enroll">${x.deviceLabel ? 'Nouveau téléphone' : 'Lien d\'activation'}</button>` : ''}
          ${x.trustedSessions ? '<button class="btn secondaire petit" data-act="reset" title="Le code sera redemandé sur tous ses appareils">Redemander le code</button>' : ''}
          <button class="btn secondaire petit" data-act="${x.active ? 'off' : 'on'}">${x.active ? 'Désactiver' : 'Réactiver'}</button>
          <button class="btn secondaire petit" data-act="del">Supprimer</button>
        </td>
      </tr>`).join('');
  }

  $('recherche').addEventListener('input', rendreCollab);

  $('liste-collab').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.closest('tr').dataset.id;
    const u = donnees.users.find((x) => x.id === id);
    try {
      switch (b.dataset.act) {
        case 'enroll': {
          if (u.deviceLabel && !confirm(`Créer un lien pour un nouveau téléphone ? Dès son activation, l'ancien téléphone de ${u.name} ne fonctionnera plus.`)) return;
          const { enrollment } = await api(`users/${id}/enroll`, { method: 'POST' });
          montrerLien(u, enrollment); break;
        }
        case 'unlock': await api(`users/${id}/unlock`, { method: 'POST' }); toast(`${u.name} est débloqué`); break;
        case 'reset': await api(`users/${id}/reset-trust`, { method: 'POST' }); toast(`Le code sera redemandé à ${u.name}`); break;
        case 'off': await api(`users/${id}`, { method: 'PATCH', body: { active: false } }); toast(`${u.name} est désactivé`); break;
        case 'on': await api(`users/${id}`, { method: 'PATCH', body: { active: true } }); toast(`${u.name} est réactivé`); break;
        case 'del':
          if (!confirm(`Supprimer ${u.name} de Gondole Key ? Son téléphone ne donnera plus de code valable.`)) return;
          await api(`users/${id}`, { method: 'DELETE' }); toast(`${u.name} est supprimé`); break;
      }
      await charger();
    } catch (err) { toast(err.message); }
  });

  $('form-collab').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user, enrollment } = await api('users', { method: 'POST', body: { login: $('c-login').value, name: $('c-nom').value, email: $('c-mail').value } });
      e.target.reset();
      await charger();
      montrerLien(user, enrollment);
    } catch (err) { toast(err.message); }
  });

  $('import-btn').addEventListener('click', async () => {
    try {
      const r = await api('users/import', { method: 'POST', body: { text: $('import-texte').value } });
      $('import-res').textContent = `${r.created} collaborateur(s) ajouté(s).` + (r.errors.length ? ' ' + r.errors.join(' — ') : '');
      if (r.created) $('import-texte').value = '';
      await charger();
    } catch (err) { toast(err.message); }
  });

  function montrerLien(u, enr) {
    $('dlg-lien-titre').textContent = `Activer le téléphone de ${u.name}`;
    $('dlg-qr').innerHTML = enr.qrSvg;
    $('dlg-lien-url').value = enr.link;
    $('dlg-expire').textContent = `Lien à usage unique, valable jusqu'au ${date(enr.expiresAt)}.`;
    const corps = `Bonjour ${u.name},\n\nPour sécuriser ta connexion à Gondole One, active Gondole Key sur ton téléphone :\n\n1. Ouvre ce lien depuis ton téléphone : ${enr.link}\n2. Sur iPhone : touche Partager puis « Sur l'écran d'accueil », et ouvre Gondole Key depuis l'icône.\n3. Touche « Activer sur ce téléphone ».\n\nUne fois par semaine, Gondole One te demandera le code affiché (il change toutes les ${donnees.period} secondes).\n\nLe lien est personnel et ne sert qu'une fois.`;
    $('dlg-mail').href = `mailto:${encodeURIComponent(u.email || '')}?subject=${encodeURIComponent('Active Gondole Key sur ton téléphone')}&body=${encodeURIComponent(corps)}`;
    $('dlg-lien').showModal();
  }
  $('dlg-copier').addEventListener('click', () => copier($('dlg-lien-url').value, 'Lien copié'));

  // ── Outils ──
  function rendreOutils() {
    $('vide-outils').classList.toggle('cache', donnees.tools.length > 0);
    $('liste-outils').innerHTML = donnees.tools.map((t) => `
      <tr data-id="${esc(t.id)}">
        <td><strong>${esc(t.name)}</strong></td>
        <td><code>${esc(t.keyPrefix)}…</code></td>
        <td><span class="etat ${t.active ? 'actif' : 'desactive'}">${t.active ? 'Relié' : 'Coupé'}</span></td>
        <td>${date(t.lastUsedAt)}</td>
        <td class="droite">
          <button class="btn secondaire petit" data-act="rotate">Nouvelle clé</button>
          <button class="btn secondaire petit" data-act="${t.active ? 'off' : 'on'}">${t.active ? 'Couper' : 'Rebrancher'}</button>
          <button class="btn secondaire petit" data-act="del">Supprimer</button>
        </td>
      </tr>`).join('');
  }

  function montrerCle(cle) { $('dlg-cle-val').value = cle; $('dlg-cle').showModal(); }
  $('dlg-cle-copier').addEventListener('click', () => copier($('dlg-cle-val').value, 'Clé copiée'));

  $('form-outil').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { apiKey } = await api('tools', { method: 'POST', body: { name: $('o-nom').value } });
      e.target.reset(); await charger(); montrerCle(apiKey);
    } catch (err) { toast(err.message); }
  });

  $('liste-outils').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.closest('tr').dataset.id;
    const t = donnees.tools.find((x) => x.id === id);
    try {
      if (b.dataset.act === 'rotate') {
        if (!confirm(`Créer une nouvelle clé pour « ${t.name} » ? L'ancienne cessera de fonctionner immédiatement.`)) return;
        const { apiKey } = await api(`tools/${id}/rotate`, { method: 'POST' }); montrerCle(apiKey);
      } else if (b.dataset.act === 'off' || b.dataset.act === 'on') {
        await api(`tools/${id}`, { method: 'PATCH', body: { active: b.dataset.act === 'on' } });
      } else if (b.dataset.act === 'del') {
        if (!confirm(`Supprimer l'outil « ${t.name} » ? Il ne pourra plus vérifier de code.`)) return;
        await api(`tools/${id}`, { method: 'DELETE' });
      }
      await charger();
    } catch (err) { toast(err.message); }
  });

  // ── Réglages ──
  function rendreReglages() {
    const s = donnees.settings;
    $('r-trust').value = s.trustDays; $('r-max').value = s.maxAttempts; $('r-lock').value = s.lockMinutes; $('r-enroll').value = s.enrollHours;
    $('r-periode').textContent = donnees.period;
  }
  $('form-reglages').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('settings', { method: 'PATCH', body: { trustDays: $('r-trust').value, maxAttempts: $('r-max').value, lockMinutes: $('r-lock').value, enrollHours: $('r-enroll').value } });
      toast('Réglages enregistrés'); await charger();
    } catch (err) { toast(err.message); }
  });

  // ── Journal ──
  const LIBELLES = {
    code_ok: 'Code validé', code_refuse: 'Code refusé', blocage: 'Compte bloqué', activation: 'Téléphone activé', creation: 'Collaborateur ajouté',
    import: 'Import de liste', modification: 'Collaborateur modifié', suppression: 'Collaborateur supprimé', lien_activation: 'Lien d\'activation créé',
    deblocage: 'Compte débloqué', reinit_confiance: 'Code redemandé', outil_cree: 'Outil relié', outil_nouvelle_cle: 'Nouvelle clé d\'outil',
    outil_supprime: 'Outil supprimé', reglages: 'Réglages modifiés', admin_connexion: 'Connexion admin', admin_echec: 'Échec connexion admin',
  };
  async function chargerJournal() {
    const { logs } = await api('logs');
    $('liste-journal').innerHTML = logs.map((l) => {
      const det = [l.login, l.tool, l.device, l.reason === 'deja_utilise' ? 'code déjà utilisé' : l.reason === 'invalide' ? 'code faux' : null, l.count !== undefined ? `${l.count} ajouté(s)` : null, l.ip].filter(Boolean).join(' — ');
      return `<tr><td>${date(l.at)}</td><td>${esc(LIBELLES[l.type] || l.type)}</td><td>${esc(det)}</td></tr>`;
    }).join('') || '<tr><td colspan="3" class="doux">Rien pour l\'instant.</td></tr>';
  }

  document.querySelectorAll('[data-fermer]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // Démarrage : session encore valable ?
  api('overview').then((d) => { donnees = d; montrerAdmin(); rendreCollab(); rendreOutils(); rendreReglages(); }).catch(() => montrerConnexion());
})();
