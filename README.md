# GONDOLE KEY

La double authentification de Gondole One.

Chaque collaborateur a sur son téléphone un code à 6 chiffres qui change toutes les **17 secondes**. Gondole One le lui demande **une fois par semaine, pour chaque outil, sur chaque appareil**. Gondole Key tourne sur **son propre serveur**, séparé de Gondole One.

---

## Ce qu'il y a dedans

| Partie | Pour qui | Adresse |
|---|---|---|
| L'appli code | Chaque collaborateur, sur son téléphone | `/app` |
| L'espace admin | Toi (créer les collaborateurs, relier les outils, régler) | `/admin` |
| Le lien d'activation | Le collaborateur, une seule fois | `/e/…` |
| L'API | Le serveur de Gondole One | `/api/v1/…` |

---

## 1. Mettre Gondole Key en ligne (Clever Cloud)

1. Dans Clever Cloud, crée une **nouvelle application Node.js** (pas dans celle de Gondole One).
2. Crée un add-on **FS Bucket** et relie-le à cette application. C'est le disque qui garde les données quand l'appli redémarre.
3. Dans **Variables d'environnement**, ajoute :

| Variable | Valeur |
|---|---|
| `MASTER_KEY` | une longue clé secrète (voir ci-dessous) |
| `ADMIN_PASSWORD` | ton mot de passe admin (12 caractères mini) |
| `PUBLIC_URL` | l'adresse de Gondole Key, ex. `https://key.gondole-one.com` |
| `CC_FS_BUCKET` | `/data:` + l'hôte du FS Bucket (affiché dans l'add-on) |
| `TOTP_PERIOD` | `17` |

Pour fabriquer `MASTER_KEY` et un mot de passe admin solides, lance sur ton PC dans le dossier : `npm run cles`.

> ⚠ **Garde `MASTER_KEY` en lieu sûr.** Si elle est perdue ou changée, tous les téléphones devront être réactivés.

4. Envoie le dossier (dépôt GitHub dédié ou `git push` vers Clever Cloud). L'appli démarre seule.
5. Ouvre `https://ton-adresse/admin` et connecte-toi.

Pour tester sur ton PC : copie `.env.example` en `.env`, remplis-le, puis `npm install` et `npm start` → http://localhost:8080/admin

---

## 2. Relier Gondole One

1. Espace admin → **Outils reliés** → donne un nom (ex. « Gondole One — CRM ») → **Relier un outil**.
2. Copie la clé affichée (elle n'est montrée qu'une fois).
3. Dans les variables d'environnement **de Gondole One**, ajoute :

| Variable | Valeur |
|---|---|
| `GONDOLE_KEY_URL` | l'adresse de Gondole Key |
| `GONDOLE_KEY_API_KEY` | la clé copiée |
| `GONDOLE_KEY_OBLIGATOIRE` | `non` pendant le déploiement, `oui` quand tout le monde est activé |
| `GONDOLE_KEY_SI_PANNE` | `bloquer` (conseillé) ou `laisser_passer` |

4. Copie dans le serveur de Gondole One :
   - `integration/gondole-key-client.js` — le module de liaison
   - `integration/ecran-code.html` — l'écran où l'on tape le code
   - et branche-les comme dans `integration/exemple-express.js` (après le contrôle du mot de passe).

Un outil = une clé. Si tu ajoutes un module à part (notes de frais, BI…), relie-le comme un nouvel outil : le code sera demandé séparément pour lui.

---

## 3. Ajouter les collaborateurs

- **Un par un** : identifiant Gondole One, nom, e-mail → **Ajouter**. Le QR code et le lien s'affichent.
- **Toute une équipe** : « Ajouter une liste d'un coup », une ligne par personne : `identifiant;nom;e-mail` (un copier-coller depuis Excel fonctionne).

Puis **Lien d'activation** → le collaborateur scanne le QR code avec son téléphone, ou reçoit le lien par e-mail (**Envoyer par e-mail** prépare le message). Le lien sert une seule fois et expire au bout de 48 h.

Sur iPhone, le message lui demande d'ajouter Gondole Key à l'écran d'accueil avant d'activer.

---

## 4. Au quotidien

| Situation | Que faire |
|---|---|
| Téléphone perdu ou changé | **Nouveau téléphone** → nouveau lien. L'ancien téléphone ne donne plus de code valable. |
| Collaborateur bloqué (5 erreurs) | Il attend 15 minutes, ou tu cliques **Débloquer**. |
| Départ d'un collaborateur | **Désactiver** (accès coupé tout de suite) ou **Supprimer**. |
| Doute sur un appareil | **Redemander le code** : il devra le ressaisir partout. |
| Clé d'outil exposée | **Nouvelle clé**, puis mets-la à jour dans Gondole One. |

Les réglages (fréquence de la demande, nombre d'erreurs, durée du blocage, validité des liens) se changent dans l'onglet **Réglages**. Tout est tracé dans le **Journal**.

---

## Sécurité, en bref

- Le code est calculé sur le téléphone, même sans réseau (norme TOTP, la même qu'Okta ou Google).
- Le secret de chaque téléphone est chiffré sur le serveur ; les clés d'outil ne sont jamais stockées en clair.
- Un code ne sert qu'une fois ; un code de plus d'une minute est refusé.
- 5 erreurs = blocage 15 minutes.
- La confiance de 7 jours est liée à l'appareil : un mot de passe volé ne suffit pas sur un autre PC.
- L'heure du téléphone est corrigée automatiquement si elle est décalée.

## Vérifier que tout marche

`npm test` lance un parcours complet (32 vérifications).
