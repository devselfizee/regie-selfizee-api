# Synchronisation des bornes avec la plateforme de suivi — API v1, schéma 1.1

Ce document s'adresse au développeur du logiciel des bornes (gammes Spherik, Kalifun, Classic). Il décrit comment une borne envoie ses **ventes** et son **état** (heartbeat) à la plateforme de suivi Régie.

La synchronisation est **directe : borne → plateforme de suivi**, sans passer par Pikcloud ni Booth. La borne n'envoie que son journal de ventes et son état. Elle n'envoie ni photos ni données personnelles.

**Nouveautés du schéma 1.1** (avenant du 07/10/2026). Les lots `1.0` restent acceptés.
- **Statuts** : ajout de `expire` (le terminal n'a pas répondu) et de `offert` (tirage imprimé, aucun débit).
- **Champs** : ajout de `encaissement` (confirmé ou incertain) et de `motif`.
- **`transaction_id`** : désormais généré par la borne. `reference_monetique` contient le numéro d'autorisation, et `reference_sequence` (facultatif) le numéro de séquence du terminal.
- **Paiement par QR (Stripe)** : module `STRIPE_QR`, moyen `web`.
- **Ventes sans tirage sur place** : produits `NUMERIQUE` et `POSTAL`, avec `nb_tirages` à 0 autorisé.
- **Module Hexapay** : `HEXAPAY` ajouté au référentiel.
- **Séances à 0 €** : moyen `aucun` et champ `gratuite`.
- **Lien avec Pikcloud** : champ `pikcloud_uuid`.
- **Heartbeat** : `ruban_restant` facultatif, référentiel des codes d'erreur publié, codes inconnus acceptés.

**Nouveautés du 27/10/2026** (avenants « parcours invité » et « ventes n° 2 » du 26/10/2026) :
- **Parcours invité** : nouvelle route `POST /ingest/v1/parcours`, une séance par objet, vente ou pas (§ 4 bis).
- **Carte** : champ facultatif `carte_fin` (quatre derniers chiffres, avec `cb` ou `sans_contact`) ; `pikcloud_uuid` accepté avec ou sans tirets.
- **Séances à 0 €** : nouvelle valeur `sans_tirage` de `gratuite` (photo enregistrée sans tirage ni paiement). Avec elle, `gratuite` peut être envoyé pour toute séance `aucun`.

**Nouveautés du 28/10/2026** (avenant n° 2 à la synchronisation des ventes) :
- **Carte** : champ facultatif `carte_derniers_chiffres` (4 chiffres, jamais avec `especes`, `aucun` ou `web`), même donnée que `carte_fin`, qui reste accepté.
- **`pikcloud_uuid`** : 32 hexadécimaux sans tirets (jeton du QR du kit nightlife) ou UUID avec tirets, envoyé tel quel.
- **Renvoi d'une vente déjà reçue** : il **complète** la ligne au lieu d'être rejeté (voir `doublons` dans la réponse).

## 1. Vue d'ensemble

| Envoi | Route | Fréquence |
|---|---|---|
| Ventes | `POST /ingest/v1/transactions` | Au verdict de chaque vente (voir § 3), par petits lots, plus le rattrapage après une coupure |
| État de la borne | `POST /ingest/v1/heartbeats` | Toutes les **5 minutes**, même sans vente |
| Parcours invité | `POST /ingest/v1/parcours` | Une fois par séance, à sa clôture, vente ou pas (§ 4 bis) |

- **URL de base** : fournie par Selfizee, en **HTTPS**. Une URL de DEV est disponible pour les essais avec le simulateur de terminal ; l'URL de PROD sera livrée ensuite.
- **Format** : JSON (UTF-8), en-tête `Content-Type: application/json`.
- **Taille maximale d'une requête** : 2 Mo.
- **Schémas JSON officiels** (à utiliser pour valider côté borne) : [`schemas/transactions.v1.schema.json`](../schemas/transactions.v1.schema.json) et [`schemas/heartbeat.v1.schema.json`](../schemas/heartbeat.v1.schema.json), plus [`schemas/parcours.v1.schema.json`](../schemas/parcours.v1.schema.json) pour les parcours (versions `"1.0"` et `"1.1"`). Les deux premiers acceptent `schema_version` `"1.0"` et `"1.1"`. Des exemples sont dans [`schemas/examples/`](../schemas/examples/).

## 2. Authentification

Chaque borne a **sa propre clé API**, envoyée dans chaque requête :

```
Authorization: Bearer rgs_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- La clé est générée sur la plateforme (page **Bornes** → « Nouvelle borne » ou « Nouvelle clé »). Elle n'est affichée qu'**une seule fois**. La borne la reçoit par le JSON de settings du serveur web Selfizee (`regieApiKey`) : rien à saisir sur la machine.
- `borne_id` est l'identifiant court déjà utilisé par les flux des bornes (`S513`, `K001`, `C042`). La borne est créée sur la plateforme avec cet identifiant, et `borne_id` doit être **exactement celui de la borne à qui appartient la clé**. Sinon la requête est refusée (403).
- Si la clé est régénérée, l'ancienne cesse immédiatement de fonctionner (`401`) : les ventes attendent en file jusqu'au prochain téléchargement des settings. Rien n'est perdu.

## 3. Envoi des ventes

Une vente part **au verdict d'enregistrement** :
- **terminal** : au moment où il répond « enregistré » ou « abandonné », ou à l'expiration du délai ;
- **QR** : à la réponse `paid` / `failed` du serveur web ;
- **séance à 0 €** : à la validation de la séance.

Elle porte donc un statut définitif et n'est plus jamais modifiée. Chaque paiement d'une même séance (par exemple « +1 pour un pote ») est une vente à part entière.

### Requête

```
POST /ingest/v1/transactions
Authorization: Bearer <clé de la borne>
Content-Type: application/json
```

```json
{
  "schema_version": "1.1",
  "borne_id": "S513",
  "envoye_le": "2026-10-05T23:15:02+02:00",
  "logiciel_version": "2026.10.1",
  "rattrapage": false,
  "transactions": [
    {
      "transaction_id": "S513-20261005-K7PX2M-1",
      "horodatage": "2026-10-05T22:47:31+02:00",
      "montant_ttc_centimes": 800,
      "devise": "EUR",
      "statut": "accepte",
      "encaissement": "confirme",
      "module": { "type": "HEXAPAY" },
      "moyen_paiement": "sans_contact",
      "reference_monetique": "554821",
      "reference_sequence": "000184",
      "pikcloud_uuid": "0f8c1c2e-5b7a-4c1e-9d2a-3f4b5c6d7e8f",
      "produit": { "code": "TIRAGE", "libelle": "2 tirages", "nb_tirages": 2 }
    }
  ]
}
```

### Enveloppe du lot

| Champ | Obligatoire | Description |
|---|---|---|
| `schema_version` | oui | `"1.1"` (`"1.0"` reste accepté). |
| `borne_id` | oui | Identifiant de la borne : majuscules, chiffres, `-` et `_` (3 à 64 caractères), ex. `S513`. |
| `envoye_le` | oui | Date et heure d'envoi du lot, **avec fuseau** (voir § Horodatages). |
| `logiciel_version` | oui | Version du logiciel de la borne. |
| `rattrapage` | non | `true` quand la borne renvoie un historique après une coupure. |
| `transactions` | oui | De **1 à 500** ventes. |

### Une vente

| Champ | Obligatoire | Description |
|---|---|---|
| `transaction_id` | oui | Identifiant **généré par la borne**, unique et stable, jamais réutilisé : `<borne>-<AAAAMMJJ>-<code séance>-<rang>` (ex. `S513-20261005-K7PX2M-2` pour le premier paiement supplémentaire). C'est la clé anti-doublon. |
| `horodatage` | oui | Date et heure de la vente, **avec fuseau**. |
| `montant_ttc_centimes` | oui | Montant TTC en **centimes, nombre entier, positif ou nul** : `800` = 8,00 €. `0` uniquement pour une séance gratuite. |
| `taux_tva_pct` | non | Taux de TVA appliqué (ex. `20`). Sinon, la plateforme applique 20 %. |
| `devise` | oui | `"EUR"` (seule devise gérée pour l'instant). |
| `statut` | oui | Voir le tableau des statuts ci-dessous. **Envoyer aussi les refus, annulations et expirations** : ils servent au taux de refus et à la détection de pannes. |
| `encaissement` | non | Avec `accepte` seulement : `confirme`, ou `incertain` si l'enregistrement a été demandé sans réponse du terminal et sans ticket retrouvé. |
| `motif` | non | Précise le statut : `invite` ou `terminal` pour `annule`, `terminal` pour `expire`, `banque` pour `refuse`. |
| `transaction_origine_id` | si remboursement | `transaction_id` de la vente d'origine (remboursements : voir plus bas). |
| `module.type` | oui | Code du type de module : `HEXAPAY`, `STRIPE_QR`, `INGENICO_SELF_2000`, `MONNAYEUR`… Un code inconnu de la plateforme est rejeté : demander à Selfizee de l'ajouter. |
| `module.numero_serie` | non | Numéro de série du terminal (réglage `terminalSerial` des settings), absent tant qu'il n'est pas renseigné. |
| `moyen_paiement` | oui | Voir le tableau des moyens ci-dessous. |
| `reference_monetique` | non | **Numéro d'autorisation** du ticket (`NO AUTO`, 6 chiffres) ou identifiant de paiement Stripe (`pi_…`) : clé du rapprochement avec les relevés du prestataire. Absent pour un refus, une annulation, une expiration. **Interdit pour les espèces et les séances gratuites.** |
| `reference_sequence` | non | Numéro de séquence du terminal (6 chiffres). |
| `gratuite` | non | Séance à 0 € : `mode_gratuit`, `code_staff`, `degrade` (terminal en panne, tirage offert), `reimpression` ou `sans_tirage` (photo enregistrée sans tirage ni paiement : voie numérique seule ou « non merci » sur l'offre). Exige `moyen_paiement` = `aucun`. |
| `pikcloud_uuid` | non | Identifiant de la photo côté PikCloud (`photo_uuid`), UUID avec ou sans tirets : la plateforme affiche la photo dans le récapitulatif de la commande. |
| `carte_derniers_chiffres` | non | **Quatre derniers chiffres de la carte** tels qu'imprimés sur le ticket (`^[0-9]{4}$`), quand le ticket est rapproché de la vente. Jamais avec `especes`, `aucun` ou `web`. Visibles des seuls administrateurs. |
| `carte_fin` | non | **Quatre derniers chiffres de la carte**, lus sur le ticket du terminal (4 chiffres). Seulement avec `cb` ou `sans_contact`, quand le ticket a été rapproché de la séance. Visibles des seuls administrateurs. |
| `code_remise` | non | Code de remise utilisé pour cette vente (§ 4 ter), tel que validé par `/codes/utiliser`. |
| `produit.code` | oui | `TIRAGE`, `TIRAGE_EXTRA` (paiement supplémentaire de la séance), `NUMERIQUE` (photo livrée en numérique seul), `POSTAL` (tirage expédié). |
| `produit.libelle` | non | Libellé de la formule tel que la borne l'affiche (ex. « 2 tirages »). |
| `produit.nb_tirages` | oui | Tirages payés, figés à l'envoi (0 à 100). `0` pour `NUMERIQUE` et pour un refus. Les réimpressions ultérieures ne modifient pas la vente. |

**Statuts**

| `statut` | Sens | Chiffre d'affaires | Taux de refus |
|---|---|---|---|
| `accepte` | Paiement accepté et enregistrement confirmé (terminal ou ticket autorisé), ou paiement QR débité. | oui (`incertain` compté, mais signalé au rapprochement) | |
| `refuse` | Carte refusée par la banque. | | oui |
| `annule` | L'invité a renoncé, ou le terminal a abandonné **avant** l'impression. | | non |
| `expire` | Aucune réponse du terminal en 2 × 60 s (carte jamais présentée, terminal muet). | | non (indicateur de panne) |
| `offert` | Accepté, impression partie, enregistrement abandonné : tirage sorti, **aucun débit**. | **non** (compté comme tirage non facturé) | |
| `rembourse` | Jamais envoyé par la borne : saisi en back-office (voir plus bas). | déduit | |

**Moyens de paiement**

| `moyen_paiement` | Sens |
|---|---|
| `cb` / `sans_contact` | D'après le ticket du terminal. |
| `mobile` | Apple Pay / Google Pay sur un terminal qui sait les distinguer (pas Hexapay, qui les présente comme du sans contact). |
| `web` | Paiement sur le téléphone de l'invité par QR, débité par le serveur web (Stripe). Module `STRIPE_QR`. |
| `especes` | Monnayeur. |
| `aucun` | Séance à 0 € (avec `statut: "accepte"`, `montant_ttc_centimes: 0` et `gratuite`, `sans_tirage` compris). |
| `autre` | Moyen inconnu (ticket non retrouvé). |

Les séances à 0 € sont **acceptées** : elles ne font ni vente ni chiffre d'affaires, mais comptent dans l'activité et la consommation de papier du lieu.

**Interdit : aucune donnée de carte bancaire** (numéro, date d'expiration, nom du porteur…). Tout champ non prévu par le schéma est refusé, ce qui empêche qu'une telle donnée soit enregistrée par erreur. Seuls les quatre derniers chiffres imprimés sur le ticket (`carte_derniers_chiffres`) sont admis.

**Règles de cohérence** (vente rejetée en `SCHEMA_INVALIDE` sinon) :
- `encaissement` seulement avec `accepte` ;
- `gratuite` seulement avec `aucun` ;
- `aucun` seulement à 0 € et avec `accepte` ;
- pas de `reference_monetique` avec `especes` ou `aucun` ;
- `transaction_origine_id` obligatoire avec `rembourse`.

### Remboursements

La borne ne rembourse jamais. Un remboursement est saisi par Selfizee dans la plateforme (page **Ventes**), rattaché à la vente d'origine ; il se déduit du chiffre d'affaires et de la base de commission du lieu. Le statut `rembourse` reste accepté dans le schéma pour compatibilité, avec `transaction_origine_id`. Une vente déjà envoyée n'est jamais renvoyée avec un statut modifié : elle serait rejetée (`CONFLIT_DOUBLON`).

### Horodatages

- Format RFC 3339 **avec fuseau obligatoire** : `2026-10-05T22:47:31+02:00` ou `2026-10-05T20:47:31Z`. Une date sans fuseau est rejetée.
- L'horloge de la borne doit être **synchronisée** (NTP sous Windows, `systemd-timesyncd` sur Raspberry Pi). C'est la date de la vente qui détermine à quel lieu elle est attribuée.

### Réponse

`200 OK`, même si certaines ventes du lot sont rejetées :

```json
{
  "import_id": "1824",
  "recues": 4,
  "creees": 3,
  "doublons": 0,
  "rejetees": 1,
  "non_affectees": 0,
  "erreurs": [
    { "index": 2, "transaction_id": "S513-20261005-K7PX2M-3", "code": "MODULE_INCONNU", "message": "Type de module \"HEXAPAY_X\" absent du référentiel" }
  ]
}
```

| Champ | Signification |
|---|---|
| `creees` | Ventes nouvelles enregistrées. |
| `doublons` | Ventes déjà reçues. Si le renvoi a le même `statut`, `montant_ttc_centimes`, `devise` et `horodatage` (et le même module et code produit), la ligne existante est **complétée** avec ses champs facultatifs : `reference_monetique`, `reference_sequence`, `moyen_paiement`, `encaissement`, `motif`, `carte_derniers_chiffres`, `pikcloud_uuid`, `code_remise`, `module.numero_serie`, `produit.libelle`. Un champ renvoyé remplace l'ancien ; un champ absent ne l'efface pas. Le statut et le montant ne changent jamais par ce chemin. |
| `rejetees` / `erreurs` | Ventes refusées, avec leur position dans le lot (`index`, à partir de 0) et le motif. Elles sont conservées côté plateforme dans la file d'erreurs : **inutile de les renvoyer telles quelles**. |
| `non_affectees` | Ventes reçues alors que la borne n'est affectée à aucun lieu à cette date. Elles sont gardées et signalées à Selfizee : rien à faire côté borne. |

Codes d'erreur par vente :

| Code | Cause |
|---|---|
| `SCHEMA_INVALIDE` | Champ manquant, mauvais format, champ non prévu, règle de cohérence non respectée (le `message` précise laquelle). |
| `MODULE_INCONNU` | `module.type` absent du référentiel de la plateforme. |
| `DEVISE_NON_GEREE` | Devise autre que `EUR`. |
| `CONFLIT_DOUBLON` | Ce `transaction_id` a déjà été reçu (ou figure deux fois dans le lot) **avec un statut, un montant, une devise, un horodatage, un module ou un produit différent**. La vente d'origine n'est jamais écrasée. |
| `HORODATAGE_FUTUR` | Vente datée de plus d'une heure dans le futur : horloge de la borne à resynchroniser. |

## 4. Envoi du heartbeat (état de la borne)

Toutes les **5 minutes**, même sans vente. C'est ce qui permet de distinguer « pas de client » de « borne en panne ».

```
POST /ingest/v1/heartbeats
Authorization: Bearer <clé de la borne>
Content-Type: application/json
```

```json
{
  "schema_version": "1.1",
  "borne_id": "S513",
  "heartbeats": [
    {
      "horodatage": "2026-10-05T23:15:00+02:00",
      "logiciel_version": "2026.10.1",
      "papier_restant": 310,
      "imprimante_ok": false,
      "module_paiement_ok": true,
      "erreurs": [{ "code": "PRN_PAPIER_ERREUR", "message": "Bourrage papier", "composant": "imprimante" }]
    }
  ]
}
```

| Champ | Obligatoire | Description |
|---|---|---|
| `horodatage` | oui | Moment de la mesure, avec fuseau. |
| `logiciel_version` | oui | Version du logiciel. |
| `papier_restant` | non | Feuilles (tirages) restantes. Sert à l'alerte consommables. |
| `ruban_restant` | non | Facultatif : à omettre sur les imprimantes qui comptent par kit papier + ruban (DNP). |
| `imprimante_ok`, `module_paiement_ok` | non | État des périphériques. |
| `erreurs` | non | Erreurs en cours : `code`, `message`, `composant` (`imprimante`, `module_paiement`, `camera`, `ecran`, `reseau`, `logiciel`, `autre`). |

**Référentiel des codes d'erreur.** Un code inconnu est **accepté et conservé** : un heartbeat n'est jamais refusé pour un libellé.

| Code | Composant | Sens |
|---|---|---|
| `PRN_ABSENTE` | imprimante | Plus vue (câble, alimentation) |
| `PRN_HORS_LIGNE` | imprimante | Hors ligne |
| `PRN_PAPIER_FIN` | imprimante | Plus de papier |
| `PRN_PAPIER_ERREUR` | imprimante | Erreur papier (bourrage, mal engagé) |
| `PRN_CAPOT` | imprimante | Capot ouvert |
| `PRN_ERREUR` | imprimante | Autre erreur, `message` = cause brute |
| `TPE_NON_PRET` | module_paiement | Terminal non prêt |
| `TPE_MUET` | module_paiement | Terminal sans réponse à la sonde |
| `TPE_OCCUPE` | module_paiement | Terminal occupé (transaction pendante, télécollecte) |
| `CAM_ABSENTE` | camera | Caméra non détectée |
| `NET_INTERNET_KO` | reseau | Lien présent, pas d'accès internet |
| `NET_PORTAIL_CAPTIF` | reseau | Portail captif |
| `SW_MODE_DEGRADE` | logiciel | Borne en mode gratuit ou staff (pas de ventes attendues) |
| `SW_ECRAN_ADMIN` | logiciel | Écran d'administration ouvert, borne indisponible |
| `ALIM_BATTERIE` | autre | Sur batterie |

Un lot peut contenir jusqu'à **2 000** heartbeats (rattrapage). Réponse : `200 OK` avec `{ "recus": 2, "crees": 2, "doublons": 0 }`. Un heartbeat déjà reçu (même borne, même horodatage) est ignoré.

## 4 bis. Envoi du parcours invité

Un **parcours** décrit une séance du kit nightlife, de la première page après l'accueil jusqu'à la clôture, **vente ou pas**. La plateforme en tire l'entonnoir de conversion de chaque lieu : séances commencées, cadre choisi, photo prise, photo vue, offre vue, paiement affiché, demandé, accepté, imprimé. Les ventes restent envoyées par `/ingest/v1/transactions` : le parcours ne les remplace pas.

`POST /ingest/v1/parcours`, même authentification, mêmes codes de réponse et mêmes règles de rattrapage que les ventes. Schéma : [`schemas/parcours.v1.schema.json`](../schemas/parcours.v1.schema.json). Un lot contient de **1 à 500** parcours.

```json
{
  "schema_version": "1.0",
  "borne_id": "S513",
  "envoye_le": "2026-10-22T23:12:00+02:00",
  "logiciel_version": "2026.10.26",
  "rattrapage": false,
  "parcours": [ { "…": "un parcours par séance" } ]
}
```

| Champ | Requis | Description |
|---|---|---|
| `parcours_id` | oui | Généré par la borne, stable : `<borne>-<AAAAMMJJ>-<code séance>`, ou `<borne>-<AAAAMMJJ>-T<HHMMSS>` sans code (séance abandonnée avant l'enregistrement). Clé anti-doublon avec la borne. |
| `evenement`, `kit` | oui | Code de l'événement photo (`FJT5`) ; `nightlife`. |
| `code_seance` | non | Dès qu'il est tiré. Les `transaction_id` des ventes de la séance commencent par `<borne>-<AAAAMMJJ>-<code>`. |
| `photo_uuid` | non | Seulement si la photo a été enregistrée. UUID, **avec ou sans tirets** (32 caractères hexadécimaux acceptés). |
| `debut`, `fin` | oui | RFC 3339 **avec fuseau** (comme les ventes). La séance est rattachée au lieu où était la borne à `debut`. |
| `duree_s` | oui | `fin − debut`, en secondes. |
| `issue` | oui | `validee`, `retour`, `delai`, `appel` ou `autre`. |
| `etapes` | oui | Une clé par étape **atteinte**, valeur = heure de la première fois : `cadre`, `prise`, `photo`, `revelation`, `offre`, `paiement`, `paiement_demande`, `impression`. Étape non atteinte : clé absente. |
| `cadre` | non | Nom du cadre choisi (fichier d'aperçu sans extension). |
| `photos`, `tirages` | oui | Poses prises ; tirages partis à l'imprimante, « +1 » compris. |
| `recommencer`, `couleurs_relances`, `retours_offre` | non | Compteurs d'hésitation. |
| `paiement` | non | Dès qu'un paiement a été demandé : `demandes`, `statut` (`accepte`, `refuse`, `annule`, `expire`, `offert`, `inconnu`), `montant_ttc_centimes`. |
| `upsell` | non | « +1 pour un pote » : `proposes`, `acceptes`, `montant_ttc_centimes`. |
| `appel`, `appel_engagee` | non | Photo d'appel lancée par la borne ; quelqu'un a touché la bandelette. |
| `rendu` | non | **1.1.** Dernier rendu choisi à la révélation : `couleur`, `noir_blanc`, `surprise`. Absent si l'invité n'a rien choisi. |
| `offre_fermeture` | non | **1.1.** Comment l'offre a été quittée la dernière fois : `non_merci`, `delai`, `paiement`, `retour`, `autre`. Seulement si l'étape `offre` est atteinte. |
| `paiement.passages`, `upsell.passages` | non | **1.1.** Un objet par passage au terminal (appui sur « Payer », ou « +1 »), dans l'ordre, 10 au plus : `statut` (requis : `accepte`, `refuse`, `annule`, `expire`, `inconnu`), `demande`, `envoi`, `reponse`, `duree_ms`, `renvoi`, `enregistrement` { `statut` (`fait`, `abandonne`, `inconnu`), `le`, `essais` }. |
| `reconstitue` | non | **1.1.** `true` : parcours déjà envoyé en 1.0, complété après coup par la borne. |

`schema_version` vaut `"1.0"` ou `"1.1"` (avenant n° 2 du 10/11/2026) ; les champs 1.1 sont acceptés dans les deux. Tout champ non prévu est refusé. Comme pour les ventes, **un parcours mal formé est rejeté seul** (`SCHEMA_INVALIDE` dans `erreurs[]`) sans bloquer le reste du lot ; seule une enveloppe invalide renvoie `400`.

**Réponse** `200` : `{ "import_id", "recus", "crees", "doublons", "enrichis", "rejetees", "non_affectees", "erreurs": [{ "index", "parcours_id", "code", "message" }] }`. Un renvoi identique (même `borne_id`, même `parcours_id`, même contenu) compte en `doublons` ; un contenu différent est refusé en `CONFLIT_DOUBLON` et l'original est gardé ; un même `parcours_id` deux fois dans le lot donne `DOUBLON_DANS_LE_LOT` pour le second.

**Exception, parcours reconstitués (1.1)** : un parcours reçu avec `reconstitue: true`, dont l'original n'a **aucun** champ 1.1 et dont tous les champs 1.0 sont identiques, **complète** l'original et compte en `enrichis`. Un second renvoi du même parcours reconstitué est un doublon ordinaire ; un champ 1.0 différent reste un `CONFLIT_DOUBLON`.

## 4 ter. Codes de remise (impressions offertes ou remisées)

Les codes sont générés dans la Régie (Codes de remise) par lots : **5 caractères**, chiffres et majuscules, sans `0`, `O`, `1`, `I` ni `L`. Un code donne soit des **impressions offertes**, soit une **remise en %** sur un nombre d'impressions ; il a une date de fin de validité et peut être réservé aux bornes d'un lieu. Contrairement aux ventes, ces appels se font **en direct**, pendant la séance (pas de file d'attente) : sans réseau, la borne refuse le code.

Même authentification que les ventes (`Authorization: Bearer rgs_…`), `borne_id` dans le corps. La borne peut envoyer le code tel que tapé (minuscules, espaces et tirets acceptés).

**Vérifier un code** (`checkCode`) — `POST /ingest/v1/codes/verifier`

```json
{ "borne_id": "S513", "code": "K7PX2" }
```

Réponse `200`, code utilisable :

```json
{ "valide": true, "code": "K7PX2", "type": "offert", "pourcentage": null, "quantite": 4, "restant": 3, "expire_le": "2027-11-03" }
```

`type` : `offert` (impressions gratuites) ou `pourcentage` (remise de `pourcentage` % sur chaque impression couverte). `restant` : impressions encore disponibles. `expire_le` : dernier jour de validité, inclus (heure de Paris).

Réponse `200`, code refusé : `{ "valide": false, "raison": "EXPIRE", "message": "Code expiré" }`. Raisons : `INCONNU`, `DESACTIVE`, `EXPIRE`, `EPUISE` (déjà entièrement utilisé), `AUTRE_LIEU` (réservé à un autre lieu).

**Utiliser un code** (`useCode`) — `POST /ingest/v1/codes/utiliser`, au moment d'imprimer

```json
{ "borne_id": "S513", "code": "K7PX2", "nb": 2, "utilisation_id": "S513-20261103-K9CTDU" }
```

| Champ | Obligatoire | Règle |
|---|---|---|
| `nb` | oui | Impressions demandées sur ce code (1 à 100). |
| `utilisation_id` | conseillé | Identifiant unique de cette utilisation pour la borne, par exemple le code de séance. Un renvoi avec le même identifiant (réponse perdue, réseau coupé) **ne décompte pas une seconde fois** : il renvoie le premier résultat avec `"deja_enregistree": true`. |

Réponse `200` :

```json
{ "ok": true, "accordees": 2, "demandees": 2, "restant": 1, "message": "2 impressions accordées" }
```

S'il reste **moins** d'impressions que demandé, la Régie accorde ce qu'il reste et le dit : `{ "ok": false, "accordees": 1, "demandees": 2, "restant": 0, "message": "Il ne restait que 1 impression sur ce code : 1 accordée sur 2 demandées" }`. La borne n'applique la remise qu'aux `accordees` impressions. Code refusé : `{ "ok": false, "accordees": 0, "raison": "…", "message": "…" }`, mêmes raisons que la vérification.

Chaque utilisation est enregistrée (borne, lieu, date, impressions) et visible dans la Régie. La vente elle-même continue d'arriver par `/transactions` : une impression remisée est une vente au montant remisé, une impression offerte une séance à 0 €.

**Relier la vente au code** (13/11/2026). Deux moyens, cumulables :
- envoyer le code dans la vente, champ facultatif **`code_remise`** (tel que tapé : casse, espaces et tirets indifférents), sur chaque vente de la séance où il a servi ;
- donner à `utilisation_id` le **code de séance** (`<borne>-<AAAAMMJJ>-<code séance>`, sans le rang) : la Régie relie alors au code toutes les ventes de la séance, y compris celles déjà envoyées.

La vente porte alors le code dans la Régie (liste des ventes, détail de la commande, recherche par code) et la fiche du code liste ses ventes.

## 4 quater. Zip de l'événement (comme getEvent et e/zip/download du booth)

Même déroulé que le booth : la borne demande l'état de son événement, puis télécharge le zip à l'URL reçue. Le zip (config.json, cadres, aperçus, photos d'exemple, éléments du kit) est **figé à chaque publication** de l'événement dans la Régie : il ne change qu'à la publication suivante, qui incrémente `version`.

**État** — `POST /ingest/v1/evenements/statut`, même authentification que les ventes

```json
{ "borne_id": "S513", "code": "RA7K" }
```

Réponse `200`, zip prêt :

```json
{
  "status": "complete",
  "code": "RA7K",
  "version": 4,
  "publieLe": "2026-11-09T10:12:00.000Z",
  "taille": 18342211,
  "sha256": "9f2c…",
  "url": "https://<api>/ingest/v1/evenements/RA7K/zip?v=4&exp=1794222000&sig=…",
  "expireLe": "2026-11-09T10:27:00.000Z"
}
```

Autres valeurs de `status` (réponse `200` aussi) : `incomplete` (événement jamais publié), `obsolete` (publié avant que la Régie fige les zips : le republier ; `version` et `message` sont fournis), `unknown` (code inconnu, ou événement d'un autre lieu que celui où la borne est installée dans la Régie).

Conseils pour la borne : ne télécharger que si `version` diffère de celle qu'elle a déjà ; vérifier le fichier reçu avec `sha256` (ou `taille`) avant de remplacer l'ancien ; garder l'ancien zip si le téléchargement échoue.

**Téléchargement** — `GET` sur `url`, sans en-tête d'authentification : l'URL est signée et vaut **15 minutes**. Réponse `200` `application/zip` (`Content-Disposition: attachment; filename="RA7K.zip"`, `Content-Length`) ; reprise d'un téléchargement interrompu avec l'en-tête `Range`. URL fausse, expirée ou version plus gardée : `404` → redemander l'état.

Différences avec le booth : la demande d'état exige la clé de la borne, et la borne doit être affectée au lieu de l'événement ; le paramètre du booth (base64 que tout le monde peut fabriquer, sans expiration) est remplacé par une signature HMAC qui expire.

## 4 quinquies. Mise à jour automatique des événements

La borne n'a plus besoin qu'on tape un code : elle demande à la Régie quel événement faire tourner, et le recharge quand il
est republié. Toutes les routes ont la même authentification que les ventes (`Authorization: Bearer <clé>`, `borne_id`
dans le corps). Les dates sont en ISO 8601 avec le décalage de Paris (`2026-11-13T20:00:00.000+01:00`), sauf `publieLe` (UTC).

**Programme** — `POST /ingest/v1/evenements/programme` `{ "borne_id": "S513" }`, au démarrage puis toutes les 5 minutes :

```json
{
  "lieu": { "id": 7, "nom": "La Ruche" },
  "maintenant": "2026-11-13T15:00:00.000+01:00",
  "actuel": { "code": "RHAL", "nom": "Halloween", "parDefaut": false, "version": 1, "publieLe": "2026-11-10T09:00:00.000Z", "status": "complete", "jusqua": "2026-11-15T00:00:00.000+01:00" },
  "prochains": [
    { "code": "RNOE", "nom": "Noël", "parDefaut": false, "version": 2, "publieLe": "…", "status": "complete", "debut": "2026-11-20T20:00:00.000+01:00", "fin": "2026-11-21T06:00:00.000+01:00" }
  ]
}
```

- `actuel` : l'événement à faire tourner maintenant. Règle de l'onglet Configuration de la Régie : parmi les événements
  personnalisés en cours, celui qui a commencé le plus tard ; sinon l'événement par défaut (`parDefaut: true`, `nom: null`).
  Un événement dont le zip n'est pas prêt (`status` ≠ `complete`) est sauté. `jusqua` : fin de l'événement, ou pour le par
  défaut le début du prochain événement prêt (`null` : rien de prévu). `actuel: null` : rien de publié, garder ce qui tourne.
- `prochains` : événements personnalisés qui commencent dans les 14 jours (10 au plus), prêts ou non, pour précharger leur zip.
- `lieu: null` : borne affectée à aucun lieu dans la Régie (rien à faire tourner).

**Versions** — `POST /ingest/v1/evenements/versions` `{ "borne_id": "S513", "codes": ["RHAL", "RNOE"] }` (comme
`getEventLastUpdate` du booth, 50 codes au plus) → `{ "evenements": [ { code, nom, parDefaut, version, publieLe, status }, … ] }` ;
un code d'un autre lieu ou inconnu : `{ "code": "RZZZ", "status": "unknown" }`.

**Installation** — `POST /ingest/v1/evenements/installation`
`{ "borne_id": "S513", "code": "RHAL", "version": 1, "etat": "INSTALLE", "message": null }`, `etat` : `TELECHARGE` (zip reçu
et vérifié), `INSTALLE` (prêt sur la borne) ou `ECHEC` (`message` : la raison) → `{ "ok": true }`. La Régie sait ainsi
quelle version tourne sur chaque borne.

**Automatique ou manuel** — `statut` et `installation` acceptent le champ facultatif `"declencheur": "auto" | "manuel"`
(mise à jour automatique, ou code tapé sur la borne). Sans lui, la Régie le déduit : un code reçu dans le `programme` de
la borne dans le dernier quart d'heure est « auto », tout autre « manuel ». Chaque étape (zip demandé, envoyé,
téléchargé, installé, échec) est gardée 180 jours dans le journal de la Régie (page « Téléchargements »). Le lien du
zip porte la borne et le déclencheur (`b`, `d`), signés avec le reste : ne pas le modifier.

Boucle conseillée : (1) `programme` ; (2) pour `actuel` et les `prochains` prêts, si `version` diffère de la version locale :
`statut` puis téléchargement (§ 4 quater), vérification `sha256`, `installation` `TELECHARGE` ; (3) basculer sur `actuel`
s'il a changé (ou à `jusqua`), `installation` `INSTALLE` ; en cas d'échec, garder l'ancien zip et signaler `ECHEC`.

## 5. Codes de réponse HTTP et comportement attendu

| Code | Signification | Que doit faire la borne |
|---|---|---|
| `200` | Lot traité (voir `erreurs` pour les lignes rejetées). | Retirer **tout le lot** de la file d'attente locale. |
| `400` `SCHEMA_INVALIDE` / `JSON_INVALIDE` | L'enveloppe du lot est invalide (ex. `transactions` vide, `borne_id` mal formé, JSON illisible). | **Ne pas renvoyer en boucle** : journaliser et corriger le logiciel. Un lot `SCHEMA_INVALIDE` est conservé dans la file d'erreurs de la plateforme ; un JSON illisible (`JSON_INVALIDE`) ne l'est pas. |
| `401` `CLE_INVALIDE` | Clé absente ou invalide. | Garder les ventes en attente ; la nouvelle clé arrive par les settings. |
| `403` `BORNE_DIFFERENTE` | `borne_id` ne correspond pas à la clé. | Corriger la configuration ; garder les ventes en attente. |
| `403` `BORNE_REFORMEE` | Borne désactivée sur la plateforme. | Arrêter les envois. |
| `413` `LOT_TROP_GROS` | Requête de plus de 2 Mo. | Découper en lots plus petits. |
| `5xx`, délai dépassé, pas de réseau | Problème temporaire. | **Réessayer plus tard** (voir ci-dessous). |

## 6. Fiabilité : file d'attente, renvois, rattrapage

Ce sont les points les plus importants : la plateforme sert à calculer ce qui est reversé aux lieux, aucune vente ne doit être perdue.

1. **File d'attente locale persistante.** Chaque vente est écrite sur le disque de la borne (un fichier JSON par vente) **avant** la demande au terminal. Elle survit à un redémarrage ou à une coupure de courant.
2. **Retrait de la file seulement après un `200`.** Tant que la plateforme n'a pas répondu `200`, la vente reste en file.
3. **Renvois sans risque.** La plateforme ignore les doublons (même `borne_id` + même `transaction_id` avec le même contenu). En cas de doute (délai dépassé, réponse non reçue), **renvoyer** : une vente comptée deux fois est impossible.
4. **Délais entre les essais** : en cas d'échec réseau ou de `5xx`, attendre de plus en plus longtemps (ex. 30 s, 1 min, 2 min, 5 min, puis toutes les 15 min), avec une petite part d'aléatoire. Délai d'attente d'une requête : 30 s.
5. **Rattrapage après une coupure.** Envoyer la file dans l'**ordre chronologique**, par lots de **500 ventes maximum**, un lot à la fois, avec `"rattrapage": true` dès que la file contient plus d'un lot ou une vente de plus d'une heure. Les heartbeats en retard sont renvoyés de même, ou abandonnés au-delà de 24 h.
6. **`transaction_id` stable.** Le même `transaction_id` désigne toujours la même vente, avec les mêmes valeurs (montant, date, statut, moyen, formule). Ne jamais réutiliser un identifiant pour une autre vente.

## 7. Exemples avec curl

```bash
# Ventes
curl -X POST https://<url-api>/ingest/v1/transactions \
  -H "Authorization: Bearer <clé de la borne>" \
  -H "Content-Type: application/json" \
  --data @transactions.json

# Heartbeat
curl -X POST https://<url-api>/ingest/v1/heartbeats \
  -H "Authorization: Bearer <clé de la borne>" \
  -H "Content-Type: application/json" \
  --data @heartbeat.json
```

## 8. Mise en service d'une borne

1. Selfizee crée la borne sur la plateforme avec son identifiant court (`S513`…), sa gamme (Spherik, Kalifun, Classic) et son module de paiement (`HEXAPAY`), puis récupère sa clé API.
2. La clé est posée dans le JSON de settings de la borne (`regieApiKey`) ; le numéro du terminal (TID), utile au rapprochement, est saisi sur la fiche de la borne.
3. Selfizee affecte la borne à son lieu (avec la date de début).
4. Vérification : la borne apparaît **« En ligne »** dans la page Bornes dans les 5 minutes (heartbeat), puis une vente test apparaît dans les statistiques du lieu.

## 9. Essais en environnement de DEV

Avant la livraison sur les bornes, les essais se font contre l'API de DEV, avec une borne de test (`S513`, gamme Spherik, module `HEXAPAY`) et le simulateur de terminal. Selfizee envoie par e-mail l'adresse HTTPS de l'API de DEV, et **séparément** la clé de la borne de test : une clé ne doit jamais figurer dans un document qui circule.

Adresses complètes, **sans `/api`** (ce préfixe sert à l'application web, pas aux bornes). Avec `/api`, la requête est refusée par l'application web avec un `401` `{"error": "Token invalide"}` : si vous voyez ce message plutôt que `CLE_INVALIDE`, c'est l'adresse qui est fausse, pas la clé :

```
POST https://<adresse de l'API>/ingest/v1/transactions
POST https://<adresse de l'API>/ingest/v1/heartbeats
```

Déroulé conseillé :
1. **Heartbeat** : `200` avec `{"recus": 1, "crees": 1, "doublons": 0}` ; la borne passe « En ligne » sur la plateforme.
2. **Un lot couvrant tous les cas** : accepté confirmé, accepté incertain, offert, refusé, annulé, expiré, paiement supplémentaire (`TIRAGE_EXTRA`), QR (`STRIPE_QR`), séance à 0 € si retenue. Attendu : `creees` = nombre de ventes, `rejetees` = 0.
3. **Le même lot une seconde fois** : `creees` = 0, `doublons` = nombre de ventes.
4. **Un lot avec une vente volontairement fausse** (par exemple `encaissement` sur un refus) : `200`, `rejetees` = 1 avec le motif, les autres ventes enregistrées.
5. **Coupure simulée** : la file se vide ensuite par lots, dans l'ordre, avec `"rattrapage": true`.

Tant que la borne de test n'est rattachée à aucun lieu, ses ventes sont gardées et comptées dans `non_affectees`, sans apparaître dans les statistiques : c'est normal en DEV.

## 10. Points encore ouverts

- **Rapprochement** : un extrait réel du journal Hexapay et d'un relevé du prestataire permettra de confirmer les colonnes (TID, numéro d'autorisation, numéro de séquence) et les tolérances.
- **Séances à 0 €** : la plateforme les accepte. C'est à Selfizee de décider si les bornes les envoient.
