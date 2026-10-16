'use strict';
/**
 * Module à copier dans le SERVEUR de Gondole One (jamais dans le navigateur :
 * la clé d'outil doit rester secrète).
 *
 * Variables d'environnement côté Gondole One :
 *   GONDOLE_KEY_URL      https://key.gondole-one.com
 *   GONDOLE_KEY_API_KEY  gk_xxxxxxxx   (donnée par l'espace admin, onglet « Outils reliés »)
 *   GONDOLE_KEY_SI_PANNE bloquer | laisser_passer   (défaut : bloquer)
 *   GONDOLE_KEY_OBLIGATOIRE non | oui   (défaut : non = pendant le déploiement, un collaborateur
 *                        sans téléphone activé passe encore ; « oui » = plus personne ne passe sans code)
 *
 * Node 18+ (fetch intégré). Aucune dépendance.
 */
const crypto = require('crypto');

class GondoleKey {
  constructor({ url = process.env.GONDOLE_KEY_URL, apiKey = process.env.GONDOLE_KEY_API_KEY, timeoutMs = 5000, siPanne = process.env.GONDOLE_KEY_SI_PANNE || 'bloquer', obligatoire = process.env.GONDOLE_KEY_OBLIGATOIRE === 'oui' } = {}) {
    if (!url || !apiKey) throw new Error('GONDOLE_KEY_URL et GONDOLE_KEY_API_KEY doivent être renseignés.');
    this.url = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.siPanne = siPanne;
    this.obligatoire = obligatoire;
  }

  async appel(route, corps) {
    const r = await fetch(`${this.url}/api/v1/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(corps),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const d = await r.json().catch(() => ({}));
    return { http: r.status, ...d };
  }

  /**
   * Faut-il demander le code à ce collaborateur, sur cet appareil ?
   * → { demander: true|false, raison }
   */
  async faut_il_demander(login, appareil) {
    try {
      const s = await this.appel('status', { login, device: appareil });
      if (s.http !== 200) throw new Error(s.message || `HTTP ${s.http}`);
      if (!s.known) return this.obligatoire ? { demander: true, raison: 'inconnu', bloquer: true } : { demander: false, raison: 'non_concerne' };
      if (!s.active) return { demander: true, raison: 'desactive', bloquer: true }; // compte coupé : on refuse
      if (!s.enrolled) return this.obligatoire ? { demander: true, raison: 'pas_encore_active', bloquer: true } : { demander: false, raison: 'pas_encore_active' };
      return { demander: s.required, raison: s.required ? 'code_requis' : 'appareil_de_confiance' };
    } catch (e) {
      console.error('[Gondole Key] injoignable :', e.message);
      return this.siPanne === 'laisser_passer' ? { demander: false, raison: 'panne' } : { demander: true, raison: 'panne', bloquer: true };
    }
  }

  /** Vérifie le code saisi. → { ok, message, restant, confianceJusqua } */
  async verifier(login, code, appareil) {
    try {
      const r = await this.appel('verify', { login, code, device: appareil });
      if (r.ok) return { ok: true, confianceJusqua: r.trustedUntil };
      return { ok: false, message: r.message || 'Code refusé.', restant: r.remaining, bloqueJusqua: r.lockedUntil };
    } catch (e) {
      return { ok: false, message: 'Le service de double authentification ne répond pas. Réessaie dans un instant.' };
    }
  }

  /** À appeler à la déconnexion si on veut que le code soit redemandé sur cet appareil. */
  async oublier_appareil(login, appareil) {
    return this.appel('revoke', { login, device: appareil }).catch(() => ({}));
  }

  /** Identifiant d'appareil : à mettre dans un cookie durable (1 an) côté Gondole One. */
  static nouvel_appareil() {
    return 'gd_' + crypto.randomBytes(18).toString('base64url');
  }
}

module.exports = { GondoleKey };
