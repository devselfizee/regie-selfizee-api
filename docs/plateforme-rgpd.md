# Plateforme RGPD (rgpd.orkessi.com, dev : rgpd.orkessidev.com) branchée sur la Régie

La plateforme RGPD (`d:/reactApp/rgpd`, SPA React) montre, exporte, corrige et efface les données que **la Régie** tient
pour une adresse e-mail. Contrat repris de l'API RGPD du booth (`Api\RgpdController`), sous `/rgpd/v1` : publique,
sans connexion, protégée par le jeton du lien envoyé par mail.

## Données concernées

Les inscriptions « Recevoir mes photos » de la page souvenir (`souvenir_inscriptions`) : adresse, prénom,
consentements (lieu, Selfizee), IP tronquée, navigateur, lot de la carte à gratter, et la photo de la séance.

- un **événement** = un code d'événement de la Régie (`id` = le code, `name` = « Lieu (Ville) — Événement ») ;
- un **enregistrement** = une inscription (`id` = son uuid), avec la photo de la séance (URL signée, 2 h).

## Jeton du lien d'accès

`base64url(iv | tag | AES-256-GCM({"e": adresse, "t": secondes}))`, valable 7 jours. Clé dérivée de `RGPD_SECRET`
(à défaut `SOUVENIR_API_SECRET`). L'adresse n'est pas lisible dans le lien, et un jeton modifié est refusé. Le jeton
du booth (triple base64, fabricable par n'importe qui) n'est pas accepté.

## Routes (`/rgpd/v1`, JSON)

| Route | Corps | Réponse |
| --- | --- | --- |
| `POST /inscription` | `{ email }` | toujours `{ error: false }` ; le mail part si l'adresse est connue (3 / heure / adresse) |
| `GET /informations/:jeton` | | `UserDataReport` ; `{ expired: true, … }` passé 7 jours ; 404 si le jeton est faux |
| `GET /export/:jeton` | | CSV (point-virgule, BOM) : une ligne par donnée |
| `POST /edition` | `{ token, photoId, fields: [{ contactId, value }] }` | `{ error: false, updated }` |
| `POST /suppression` | `{ token, photoId, target }` ou `{ token, eventId }` | `{ error: false, deleted, photoKept }` |

- **Modifiables** : `prenom`, `optinLieu`, `optinSelfizee` (`Oui` / `Non`). L'adresse ne se modifie pas (elle est la clé
  d'accès) : pour en changer, effacer puis se réinscrire.
- **`target`** :
  - `both` (défaut) efface l'adresse, le prénom et les traces techniques, puis la photo si personne d'autre ne l'a
    demandée (photo de groupe : `photoKept`) ;
  - `data` efface le prénom et les traces, et retire les consentements ; l'adresse reste ;
  - `photo` efface la photo seule. Il est refusé en 409 (`PHOTO_PARTAGEE`) si d'autres personnes l'ont demandée.
- **`eventId`** : chaque inscription de l'adresse sur ce code, comme `both`.
- **Erreurs** : `{ error: CODE, message }`, avec 403 pour un lien expiré, 404 pour un enregistrement absent ou d'une autre
  adresse, et 429 au-delà des limites.

## Mails (Paramètres → E-mails RGPD)

| Modèle | Destinataire | Variables |
| --- | --- | --- |
| `RGPD_ACCES` | l'adresse demandée | `{{lien}}` (bouton, ajouté s'il manque), `{{validite}}`, `{{plateforme}}`, `{{email}}` |
| `RGPD_NOTIFICATION` | adresses réglées (défaut `dpo@selfizee.fr` ; vide : rien) | `{{action}}`, `{{email}}`, `{{evenements}}`, `{{date}}`, `{{details}}` |

Le corps est du texte riche, nettoyé à l'enregistrement (gras, italique, souligné, listes). Les valeurs sont échappées.
« Envoyer un essai » envoie le modèle enregistré, avec des valeurs d'exemple, à l'adresse de l'utilisateur.
L'expéditeur est `SENDER_SELFIZEE`.

## Variables d'environnement

- `RGPD_SECRET` : clé du lien (la changer invalide les liens en cours) ;
- `RGPD_URL` : adresse de la plateforme (défaut `https://rgpd.orkessi.com` ; dev : `https://rgpd.orkessidev.com`) ;
- `RGPD_CORS_ORIGIN` : origines autorisées, sans slash final (défaut `*`) : `https://rgpd.orkessi.com` en prod, `https://rgpd.orkessidev.com` en dev.

Côté plateforme : `VITE_API_BASE_URL` = adresse de l'API Régie.
