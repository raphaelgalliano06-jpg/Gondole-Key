'use strict';
/**
 * EXEMPLE — comment brancher Gondole Key dans le serveur de Gondole One (Express).
 * À adapter aux noms de routes et de session réels de Gondole One.
 *
 * Parcours :
 *  1. Le collaborateur se connecte comme d'habitude (identifiant + mot de passe).
 *  2. Gondole One demande à Gondole Key : « faut-il le code sur cet appareil ? »
 *  3. Si oui → écran « ecran-code.html ». Sinon → accès direct.
 *  4. Le code est vérifié par Gondole Key ; l'appareil est mémorisé pour 7 jours.
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { GondoleKey } = require('./gondole-key-client');

const app = express();
const key = new GondoleKey(); // lit GONDOLE_KEY_URL et GONDOLE_KEY_API_KEY
app.use(express.json());
app.use(cookieParser());
// … votre middleware de session existant (req.session) …

// Identifiant d'appareil durable (1 an), propre à chaque navigateur / téléphone.
function appareil(req, res) {
  let id = req.cookies.gd_appareil;
  if (!id || !/^gd_[A-Za-z0-9_-]{20,}$/.test(id)) {
    id = GondoleKey.nouvel_appareil();
    res.cookie('gd_appareil', id, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 365 * 86400000 });
  }
  return id;
}

// 1-2. Après le contrôle du mot de passe EXISTANT de Gondole One :
app.post('/connexion', async (req, res) => {
  const utilisateur = await verifierMotDePasse(req.body.login, req.body.motDePasse); // ← votre fonction actuelle
  if (!utilisateur) return res.status(401).json({ message: 'Identifiant ou mot de passe incorrect.' });

  const decision = await key.faut_il_demander(utilisateur.login, appareil(req, res));
  if (decision.bloquer && decision.raison !== 'panne') return res.status(403).json({ message: 'Accès refusé. Contacte ton responsable.' });

  req.session.login = utilisateur.login;
  req.session.doubleAuthOk = !decision.demander;
  res.json({ suite: decision.demander ? '/double-auth' : '/' });
});

// 3. Écran de saisie du code
app.get('/double-auth', (req, res) => {
  if (!req.session.login) return res.redirect('/connexion');
  res.sendFile(path.join(__dirname, 'ecran-code.html'));
});

// 4. Vérification du code
app.post('/double-auth', async (req, res) => {
  if (!req.session.login) return res.status(401).json({ message: 'Session expirée, reconnecte-toi.' });
  const r = await key.verifier(req.session.login, String(req.body.code || ''), appareil(req, res));
  if (!r.ok) return res.status(401).json(r);
  req.session.doubleAuthOk = true;
  res.json({ ok: true, suite: '/' });
});

// Garde-fou : toutes les pages et API protégées passent par ici.
function exigerDoubleAuth(req, res, next) {
  if (req.session.login && req.session.doubleAuthOk) return next();
  if (req.accepts('html')) return res.redirect(req.session.login ? '/double-auth' : '/connexion');
  res.status(401).json({ message: 'Double authentification requise.' });
}
app.use('/api', exigerDoubleAuth);

module.exports = app;
