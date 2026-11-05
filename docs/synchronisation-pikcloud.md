# Synchronisation des médias PikCloud → Régie

Mise en œuvre côté Régie du contrat d'interface rédigé par l'équipe PikCloud (*Synchronisation des médias PikCloud → plateforme Régie*, version 1 du 04/11/2026). Ce document complète le contrat : il décrit ce que Régie fait de chaque appel, et liste ce que l'équipe PikCloud doit renseigner de son côté.

## 1. Endpoint

| | |
|---|---|
| Méthode | `POST` |
| Chemin | `/webhooks/v1/pikcloud/medias` |
| Corps | JSON, 64 Ko maximum |
| Authentification | en-tête `X-Synchro-Token: <secret partagé>` |
| Réponse | HTTP `200`, corps JSON avec une entrée `data` et/ou `photo` |

À transmettre à l'équipe PikCloud (`config/pikcloud.php` : `url_regie_synchro`, `regie_synchro_secret`) :

| Environnement | URL | Secret |
|---|---|---|
| dev | `https://<api-regie-dev>/webhooks/v1/pikcloud/medias` | valeur de `PIKCLOUD_SYNCHRO_SECRET` sur l'API de dev |
| prod | `https://<api-regie>/webhooks/v1/pikcloud/medias` | valeur de `PIKCLOUD_SYNCHRO_SECRET` sur l'API de prod |

Le secret se génère par exemple avec `openssl rand -base64 32`. Un secret différent par environnement.

## 2. Configuration côté Régie

| Variable | Rôle |
|---|---|
| `PIKCLOUD_SYNCHRO_SECRET` | secret partagé. Vide : le webhook répond `503` et PikCloud garde ses fichiers « en cours » puis renvoie. |
| `PIKCLOUD_HOTES_AUTORISES` | hôtes dont on accepte les liens `data_url` / `media_url`, séparés par des virgules. Défaut : `api.pikcloud.io,apidev.pikcloud.io`. |
| `PIKCLOUD_VERIFIER_LIENS` | `HEAD` de 3 s sur chaque lien à la réception : un lien qui répond 404 ou 5xx vaut un `4002` immédiat. `0` pour couper. Hors tests, actif par défaut. |
| `MEDIAS_DIR` | dossier des copies (défaut `./medias` ; en prod le volume `medias` monté sur `/app/medias`, voir `docker-compose.yml`). |
| `MEDIAS_TAILLE_MAX_MO` | taille maximale d'un média, défaut 200 (vidéos jusqu'à ~100 Mo). |
| `MEDIAS_TENTATIVES_MAX` | échecs de téléchargement avant de passer le fichier en erreur, défaut 5. |
| `MEDIAS_RETENTION_JOURS` | purge des fichiers N jours après la séance (`save_date`, à défaut réception). Vide : pas de purge, durée à fixer par Selfizee. |

## 3. Ce que Régie fait d'un appel

1. Vérifie le secret (comparaison en temps constant) : `401` s'il est absent ou faux.
2. Valide le corps : `400` (`SCHEMA_INVALIDE`) s'il ne respecte pas le contrat (par exemple `filename` avec un chemin, ou ni `data_url` ni `media_url`). Les champs inconnus sont ignorés, et toute valeur de `type_media` est acceptée.
3. Trace l'appel dans `import_lots` (type `MEDIAS`, payload brut conservé). Les anomalies vont dans la file d'erreurs de la page **Imports**.
4. Retrouve ou crée la ligne `medias` de la séance (clé `code_event` + `filename`), rattachée à l'événement par son code (`config_evenements.code`), au lieu de l'événement, et à la borne par `borne`.
5. Pour chaque lien présent, vérifie qu'il répond (`HEAD`, 3 s), enregistre l'URL telle quelle et met le fichier **en attente de téléchargement**. Rien n'est téléchargé pendant l'appel : la réponse part en moins d'une seconde dans le cas courant.
6. Répond `200` avec une entrée par fichier présent, et lance une passe du worker en tâche de fond.

Le worker ([src/synchro-pikcloud/telechargement.ts](../src/synchro-pikcloud/telechargement.ts)) passe aussi toutes les minutes en rattrapage :

- `GET` sur le lien, en flux vers `MEDIAS_DIR` sous `<2 premiers caractères de l'uuid>/<uuid>.<ext>` (fichier temporaire puis renommage), SHA-256 et taille calculés au passage, taille plafonnée.
- JSON : lecture des champs utiles (`photo_uuid`, `date_photo`, `save_date`, `print_date`, `count_print`, `testMode`, dates interprétées en Europe/Paris), JSON complet gardé dans `brut`. Les paiements ne sont pas exploités.
- Images (`jpg`, `png`, `gif`, `webp`) : vignette JPEG de 480 px de large à côté du fichier. Vidéos : pas de vignette.
- Échec : nouvel essai après `tentatives × 2 min`, puis au bout de `MEDIAS_TENTATIVES_MAX` le fichier passe en `ERREUR` avec une ligne dans la page **Imports** (`TELECHARGEMENT_IMPOSSIBLE` ou `JSON_ILLISIBLE`). Un renvoi PikCloud le remet en attente.

Ordre d'arrivée : le média peut arriver avant son JSON (cas C du contrat) ; il attend sur la même ligne, le JSON le rejoint au cas A ou B suivant.

## 4. Codes de réponse Régie (plage 4000-4999)

| Code | `success` | Message | Quand |
|---|---|---|---|
| 200 | `true` | `OK` | fichier enregistré, téléchargement lancé |
| 200 | `true` | `Fichier déjà reçu` | renvoi d'un fichier déjà téléchargé : rien n'est refait, aucun doublon |
| 200 | `true` | `Fichier enregistré, téléchargement en attente` | renvoi d'un fichier pas encore téléchargé : le lien le plus récent est gardé |
| 4001 | — | `Événement inconnu côté Régie` | réservé : aujourd'hui un code inconnu est **accepté** (`success: true`), le média est stocké sans lieu et signalé dans la file d'erreurs ; il est rattaché dès qu'un renvoi arrive après la création de l'événement. Refuser provoquerait 12 renvois pour rien. |
| 4002 | `false` | `Téléchargement du média impossible` | le lien ne répond pas (worker) |
| 4003 | `false` | `JSON de séance illisible` | le fichier `data` n'est pas un JSON exploitable (worker) |
| 4004 | `false` | `Lien hors des hôtes PikCloud autorisés : <hôte>` | l'URL ne pointe pas vers un hôte de `PIKCLOUD_HOTES_AUTORISES` ; l'autre fichier de l'appel est traité normalement |

Un fichier en erreur côté Régie (téléchargement échoué plusieurs fois) est remis en attente par le renvoi suivant de PikCloud, automatique ou manuel.

## 5. Règles de traitement

- **Un renvoi ne remplace jamais un fichier déjà reçu** (contrat § 3.2). Les colonnes lues dans le JSON ne sont pas réécrites. Le CDC page souvenir du 21/10/2026 (§ 2.1) prévoyait une mise à jour du JSON après paiement : le contrat du 04/11, plus récent et tiré du code, dit l'inverse, et c'est lui qui est suivi. Le chiffre d'affaires vient de l'ingestion des ventes des bornes, pas des paiements du JSON.
- **`is_fake` et `testMode`** : la séance est marquée `test` et exclue de la galerie par défaut. Rien n'est déclenché pour le public.
- **Conservation** : PikCloud supprime ses fichiers 90 jours après réception, Régie garde sa copie sur le volume `MEDIAS_DIR`. Une purge horaire supprime fichier et vignette des médias plus anciens que `MEDIAS_RETENTION_JOURS` (la ligne reste, en `PURGE`, avec ses compteurs). Tant que la variable est vide, rien n'est purgé : la durée est à fixer par Selfizee, la page souvenir purge à 90 jours.

## 6. Essai en local

```bash
curl -X POST http://localhost:3003/webhooks/v1/pikcloud/medias \
  -H 'Content-Type: application/json' \
  -H 'X-Synchro-Token: <PIKCLOUD_SYNCHRO_SECRET>' \
  -d '{"platform":"regie","source":"upload","code_event":"RTS1","borne":"S99","type_media":"multipose","filename":"2026_11_03_16_23_00_00013","data_url":"https://apidev.pikcloud.io/uploads/S99/files/RTS1/Data/2026_11_03_16_23_00_00013.json","media_url":"https://apidev.pikcloud.io/uploads/S99/files/RTS1/multipose/2026_11_03_16_23_00_00013.jpg","is_fake":true}'
```

Réponse attendue :

```json
{
  "data":  { "success": true, "status": { "code": 200, "message": "OK" } },
  "photo": { "success": true, "status": { "code": 200, "message": "OK" } }
}
```

Les deux liens sont de vrais fichiers de test sur l'environnement de dev PikCloud (événement `RTS1`, borne `S99`). Comme `RTS1` n'existe pas dans Régie, la ligne est créée sans lieu et une erreur `EVENEMENT_INCONNU` apparaît dans la page Imports.

## 7. État

| Étape | État |
|---|---|
| Table `medias`, réception, idempotence, codes de réponse | en place, 13 tests |
| Worker de téléchargement, lecture du JSON, vignettes, vérification des liens | en place, 14 tests |
| Rétention et purge | en place, durée à fixer par Selfizee (`MEDIAS_RETENTION_JOURS`) |
| Galerie (API et front) | à faire |
