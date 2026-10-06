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
| Back-office API (lieux, bornes, affectations, stats, exports) | [src/routes](src/routes) | en place, 114 tests OK |
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
| `GET /api/export/transactions.csv|.xlsx` · `/classement.csv|.xlsx` | exports CSV (séparateur ;) et Excel (vrais nombres et dates, format €, filtres) |

- **Authentification** : chaque borne a sa propre clé (`Authorization: Bearer rgs_…`), dont seul le hash est stocké. Le `borne_id` du JSON doit correspondre à la clé.
- **Idempotence** : un renvoi identique est compté comme doublon et ne modifie rien. Un même `transaction_id` renvoyé avec un contenu différent va dans la file d'erreurs (`CONFLIT_DOUBLON`) et n'est jamais écrasé.
- **Rejets** : une transaction invalide ne bloque pas le reste du lot. Les rejets sont tracés avec leur motif dans `import_erreurs`, et le payload brut de chaque lot est conservé.
- **Rattachement** : chaque transaction va au lieu actif à sa date. Sans affectation, elle est stockée sans lieu et une alerte `BORNE_NON_AFFECTEE` est levée (une par borne et par jour).
- **Agrégats** : `agg_jour` et `agg_heure` sont mis à jour dans la même transaction SQL que l'insertion. `recalculerAgregats()` reconstruit une période, par exemple après la correction d'une affectation.
- **Temps** : stockage en UTC (`timestamptz`). Le jour et l'heure locaux (Europe/Paris) sont calculés à l'ingestion.
- **Montants** : en centimes ; les taux sont en points de base (2000 = 20 %).
- **Hébergement** : Coolify (Docker Compose), serveur en France ou dans l'UE. La base est une ressource PostgreSQL Coolify séparée, passée par `DATABASE_URL` (activer « Connect to Predefined Network » sur l'API pour joindre son hôte interne).

## Commissions et reversements (V1.1)

- **Contrat versionné par lieu** : chaque avenant crée une nouvelle version, avec une date d'effet au **début d'une période** (mois, trimestre, année ; ou une saison de la fiche lieu). Un avenant ne peut pas prendre effet sur une période déjà validée.
- **Modèles** : aucune commission, pourcentage, pourcentage après seuil (taux **au-delà** du seuil ou sur **tout le CA dès le seuil atteint**), paliers (**chaque tranche à son taux** ou **taux du palier atteint sur tout le CA**), forfait (+ % optionnel). Le **minimum garanti** se combine avec tous les modèles.
- **Base** : CA TTC ou HT, net des remboursements ou non. **Seuil cumulé** depuis la date d'effet : commission de la période = calcul sur le cumul à la fin de la période − calcul sur le cumul au début (la somme des périodes égale le calcul sur le total).
- **Reversements** : calculés automatiquement chaque heure pour les périodes terminées (`POST /api/reversements/calculer` pour forcer). Tant qu'une période n'est pas validée, elle est recalculée si des ventes arrivent en retard ; les **corrections manuelles** (montant, motif, auteur) sont conservées. Statuts : à valider → validé → facturé par le lieu / autofacturé → payé.
- **Relevé PDF** par période (détail du calcul et des ventes par jour), téléchargeable et **envoyé par e-mail** au lieu (Mailjet, PDF en pièce jointe) une fois validé : un par un (destinataires choisis) ou en groupe (contacts de la fiche : comptabilité, sinon gérant). Date d’envoi tracée. **Export compta** des reversements validés, en CSV ou Excel.
- Moteur : [src/commissions/moteur.ts](src/commissions/moteur.ts) (fonctions pures, testées sur chaque exemple du CDC).

## Alertes (V1.1)

Évaluées toutes les 15 minutes ([src/alertes/evaluation.ts](src/alertes/evaluation.ts)), chaque lieu comparé à son propre historique, **uniquement sur ses jours et heures d'ouverture** (saisons, fermetures, horaires de la fiche ; sans horaires : 10 h–22 h) pour éviter les fausses alertes.

| Alerte | Par défaut | Résolution |
|---|---|---|
| Borne muette | pas de heartbeat depuis 2 h, lieu ouvert depuis au moins 2 h — critique | automatique |
| Zéro vente inhabituel | aucune vente depuis 3 h sur un créneau qui vend (≥ 3 ventes en moyenne, même jour/heures, 4 semaines) | automatique |
| Baisse de CA | CA par jour ouvert sur 7 j < 60 % des 28 j précédents (< 30 % : critique) | manuelle |
| Taux de refus | > 20 % de refus sur 24 h (≥ 10 tentatives) | manuelle |
| Pic suspect | CA de la veille > 3 × la moyenne et ≥ 100 € | manuelle |
| Vente hors horaires | ≥ 3 ventes de la veille hors horaires de la fiche — info | manuelle |
| Consommables | papier ou ruban < 50 tirages | automatique |

Seuils et niveaux réglables (page Paramètres → Règles d'alerte). Une anomalie déjà ouverte n'est pas relevée deux fois ; une alerte ignorée ne revient pas avant le lendemain.

**Notifications** (e-mails Mailjet `MAILJET_API_KEY`/`MAILJET_API_SECRET`, SMS SMSEnvoi `SMSENVOI_EMAIL`/`SMSENVOI_APIKEY` — les services du CRM) : critique → e-mail + SMS, warning → e-mail, info → récapitulatif seul. Destinataires : admins ; techniciens pour les alertes techniques ; commercial du lieu pour les alertes de vente. Récapitulatif quotidien à 8 h aux admins. Chaque envoi est tracé (`notifications_alerte`). Sans identifiants, rien n'est envoyé.

## Coûts, interventions et rentabilité (V2)

- **Coûts par borne** (consommables, déplacements, interventions, pièces…) et **interventions SAV** (motif, compte-rendu, panne du… au…, coût enregistré comme coût de la borne), saisis par l’admin ou le technicien. Les interventions apparaissent sur la courbe de CA du lieu.
- **Marge nette** d’une borne sur une période = CA HT net des remboursements − commissions (part de la borne dans les reversements calculés, au prorata de son CA dans le lieu et des jours communs) − coûts − amortissement (linéaire au jour sur la durée d’amortissement).
- **Retour sur investissement** : marge avant amortissement cumulée depuis la mise en service, comparée au prix d’achat ; date de retour, ou mois restants au rythme des 3 derniers mois complets.
- `GET /api/rentabilite` et `/api/rentabilite/bornes/:id` : réservés à l’admin (prix d’achat, commissions).
- **Marge par lieu** dans l’analyse par segment (admin) : CA HT − commissions versées au lieu − coûts et amortissement de ses bornes pendant leur présence ; aussi ramenée au jour ouvert.
- Consommables : saisie manuelle. L’API de stock existante (`stock-management`) gère les pièces de fabrication des bornes, sans mouvement rattaché à une borne en exploitation : pas de lien automatique possible en l’état.

## Analyse par segment (V2)

`GET /api/stats/segments?x=<critère>&y=<critère>` (CDC §5.3) : indicateurs **normalisés** par lieu — CA par jour d’ouverture effectif (lieu ouvert d’après sa fiche **et** équipé d’une borne : un lieu installé en cours de période n’est pas pénalisé), CA par heure d’ouverture, CA par place (capacité), CA par visiteur (fréquentation) — et croisement de deux critères de la fiche (type, zone, standing, clientèle, emplacement, heure de fermeture, capacité, commercial…) avec **moyenne, médiane et nombre de lieux** par case. Un lieu saisonnier sans saison saisie est considéré ouvert toute l’année (signalé sur sa fiche).

## Carte des lieux (V2)

`GET /api/stats/carte` : position et performance de chaque lieu (CA, CA par jour ouvert, évolution vs période précédente), mêmes filtres que la vue globale. Les lieux sont géolocalisés d’après leur adresse par la **Géoplateforme IGN** (Base Adresse Nationale, sans clé) à l’enregistrement de la fiche ; les coordonnées saisies à la main sont conservées ; sans rue, la recherche se limite aux communes. `POST /api/lieux/geocoder` place d’un coup les lieux sans coordonnées. Fond de carte : Plan IGN.

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
