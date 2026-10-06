# regie-selfizee-api

Suivi du CA des bornes installées en régie, calcul des commissions reversées aux lieux, alertes.

API de la plateforme de suivi Régie Selfizee / Ma Trombine. Front : [regie-selfizee-web](https://github.com/devselfizee/regie-selfizee-web).

Référence : *CDC — Plateforme de suivi Régie Selfizee / MaTrombine* (2 oct. 2026).

## État

| Livrable | Fichier | État |
|---|---|---|
| Schéma de base de données | [prisma/schema.prisma](prisma/schema.prisma) + [contraintes SQL](prisma/sql/contraintes.sql) | proposé, `prisma validate` OK |
| Schéma JSON d'ingestion v1 | [transactions](schemas/transactions.v1.schema.json), [heartbeat](schemas/heartbeat.v1.schema.json), [exemples](schemas/examples/) | proposé, validé avec ajv |
| Synchronisation des bornes (doc pour le développeur des bornes) | [docs/synchronisation-bornes.md](docs/synchronisation-bornes.md) · [version illustrée HTML / PDF](docs/synchronisation-bornes.html) | à jour |
| Points à arbitrer | [docs/questions-ouvertes.md](docs/questions-ouvertes.md) | à arbitrer |
| API d'ingestion | [src](src) | en place, 17 tests OK |
| Back-office API (lieux, bornes, affectations, stats, exports) | [src/routes](src/routes) | en place, 42 tests OK |
| Front : vue globale, lieux (liste, fiche + stats, formulaire), bornes, file d'erreurs | [regie-selfizee-web](https://github.com/devselfizee/regie-selfizee-web) | en place |
| Maquettes, chiffrage | — | à faire |

## Architecture

Mêmes conventions que `ventes-bornes`. Deux dossiers, destinés à devenir deux dépôts Git :

```
regie-selfizee/
├── api/   Node.js + Express + Prisma + PostgreSQL 16 (ajv, Keycloak realm konitys)   → port 3003
└── web/   Next.js + Tailwind                                                       → port 3000
```

## Démarrer en local

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml up -d      # PostgreSQL sur le port 5435
docker exec regie-postgres-local psql -U postgres -c "CREATE DATABASE regie_test"   # une seule fois
npm install
npx prisma migrate dev
npx prisma db seed        # listes, gammes, modules + borne de démo MT-0042 (affiche sa clé)
npm run dev               # http://localhost:3003

npm test                  # tests unitaires + intégration (base regie_test)
npm run test:unit         # sans base
npm run borne:cle -- MT-0042   # (ré)générer la clé API d'une borne
npm run demo              # (API démarrée) 4 lieux + ~3 mois de ventes envoyées par l'API d'ingestion
```


Pour envoyer un lot de test :

```bash
curl -X POST localhost:3003/ingest/v1/transactions   -H "Authorization: Bearer <clé borne>" -H "Content-Type: application/json"   --data @schemas/examples/transactions.ok.json
```

## API d'ingestion (V1, en place)

| Route | Rôle |
|---|---|
| `POST /ingest/v1/transactions` | lot de 1 à 500 transactions ([schéma](schemas/transactions.v1.schema.json)) |
| `POST /ingest/v1/heartbeats` | état de la borne, toutes les 5 min ([schéma](schemas/heartbeat.v1.schema.json)) |
| `GET /api/imports/erreurs` | file d'erreurs d'import (back-office, Keycloak) |
| `PATCH /api/imports/erreurs/:id` | marquer une erreur retraitée / ignorée |
| `GET /api/imports/non-affectees` | ventes reçues de bornes sans lieu |
| `GET /api/referentiel` · `POST /api/referentiel/valeurs` … | listes administrables, gammes, types de module |
| `GET/POST/PUT /api/lieux` | fiches lieux (horaires, saisons, fermetures, contacts, clientèles) |
| `GET/POST/PUT /api/bornes` · `POST /api/bornes/:id/cle` | bornes et clés API |
| `POST/PATCH/DELETE /api/affectations` | affectation / déplacement / retrait ; les ventes sont réattribuées et les agrégats recalculés |
| `GET /api/stats/global` · `GET /api/stats/lieux/:id` | vues globale et par lieu, filtrables (période, gamme, module, moyen, tout champ de la fiche lieu) |
| `GET /api/export/transactions.csv` · `/classement.csv` | exports CSV (séparateur ;, ouvrables dans Excel) |

- **Authentification** : chaque borne a sa propre clé (`Authorization: Bearer rgs_…`), dont seul le hash est stocké. Le `borne_id` du JSON doit correspondre à la clé.
- **Idempotence** : un renvoi identique est compté comme doublon et ne modifie rien. Un même `transaction_id` renvoyé avec un contenu différent va dans la file d'erreurs (`CONFLIT_DOUBLON`) et n'est jamais écrasé.
- **Rejets** : une transaction invalide ne bloque pas le reste du lot. Les rejets sont tracés avec leur motif dans `import_erreurs`, et le payload brut de chaque lot est conservé.
- **Rattachement** : chaque transaction va au lieu actif à sa date. Sans affectation, elle est stockée sans lieu et une alerte `BORNE_NON_AFFECTEE` est levée (une par borne et par jour).
- **Agrégats** : `agg_jour` et `agg_heure` sont mis à jour dans la même transaction SQL que l'insertion. `recalculerAgregats()` reconstruit une période, par exemple après la correction d'une affectation.
- **Temps** : stockage en UTC (`timestamptz`). Le jour et l'heure locaux (Europe/Paris) sont calculés à l'ingestion.
- **Montants** : en centimes ; les taux sont en points de base (2000 = 20 %).
- **Hébergement** : Coolify (Docker Compose), serveur en France ou dans l'UE. La base est une ressource PostgreSQL Coolify séparée, passée par `DATABASE_URL` (activer « Connect to Predefined Network » sur l'API pour joindre son hôte interne).

## Utilisateurs et droits

Le realm Keycloak `konitys` est partagé : être connecté ne suffit pas. Un admin ajoute chaque personne (e-mail + rôle) dans la page **Utilisateurs** ; le compte Keycloak est rattaché par e-mail à la première connexion. Les adresses de `ADMIN_EMAILS` deviennent ADMIN automatiquement (amorçage).

| | Admin | Commercial | Technicien | Partenaire |
|---|---|---|---|---|
| Lieux | tous | ses lieux (création, modification) | lecture, sans CA | son lieu, lecture |
| Stats et exports | tout | ses lieux | — | son lieu |
| Bornes, affectations, clés, imports | ✓ | — | ✓ | — |
| Listes administrables, utilisateurs | ✓ | — | — | — |

En local sans Keycloak, l'API considère l'appelant comme admin ; l'en-tête `X-Dev-Utilisateur: <email>` permet de tester un autre rôle (ignoré en production).

## Phasage (CDC §9.3)

1. **V1, socle** : lieux, bornes, affectations, ingestion, vue globale, vue par lieu, exports.
2. **V1.1, argent** : commissions, relevés PDF, alertes de baisse de CA et de borne muette.
3. **V2, analyse** : segmentation croisée, indicateurs normalisés, coûts et marge, espace partenaire, carte.
4. **V3, pilotage** : prévisions, météo et calendrier, scoring des prospects.

Les tables V2 (coûts, interventions, événements) sont déjà dans le schéma. Elles sont peu coûteuses maintenant et évitent une migration lourde plus tard.
