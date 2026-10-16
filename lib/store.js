'use strict';
/**
 * Stockage : un fichier JSON écrit de façon atomique (+ copie de secours).
 * Sur Clever Cloud, DATA_DIR doit pointer vers un FS Bucket (disque persistant).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  trustDays: 7,       // une demande par semaine, par outil et par appareil
  maxAttempts: 5,     // erreurs avant blocage
  lockMinutes: 15,    // durée du blocage
  enrollHours: 48,    // validité d'un lien d'activation
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'gondole-key.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this.load();
  }

  load() {
    for (const f of [this.file, this.file + '.bak']) {
      try {
        if (fs.existsSync(f)) {
          const d = JSON.parse(fs.readFileSync(f, 'utf8'));
          d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
          for (const k of ['users', 'tools', 'enrollments', 'trust']) d[k] = d[k] || {};
          d.logs = d.logs || [];
          return d;
        }
      } catch (e) {
        console.error(`[store] lecture impossible de ${f} :`, e.message);
      }
    }
    return { version: 1, settings: { ...DEFAULT_SETTINGS }, users: {}, tools: {}, enrollments: {}, trust: {}, logs: [] };
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(tmp, this.file);
  }

  log(type, details = {}) {
    this.data.logs.push({ at: Date.now(), type, ...details });
    if (this.data.logs.length > 3000) this.data.logs.splice(0, this.data.logs.length - 3000);
  }

  purge() {
    const now = Date.now();
    let changed = false;
    for (const [k, v] of Object.entries(this.data.trust)) if (v.until < now) { delete this.data.trust[k]; changed = true; }
    for (const [k, v] of Object.entries(this.data.enrollments)) if (v.expiresAt < now) { delete this.data.enrollments[k]; changed = true; }
    if (changed) this.save();
  }

  userByLogin(login) {
    const l = String(login || '').trim().toLowerCase();
    return Object.values(this.data.users).find((u) => u.login === l) || null;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
