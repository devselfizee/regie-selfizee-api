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

## 1. Vue d'ensemble

| Envoi | Route | Fréquence |
|---|---|---|
| Ventes | `POST /ingest/v1/transactions` | Au verdict de chaque vente (voir § 3), par petits lots, plus le rattrapage après une coupure |
| État de la borne | `POST /ingest/v1/heartbeats` | Toutes les **5 minutes**, même sans vente |

- **URL de base** : fournie par Selfizee, en **HTTPS**. Une URL de DEV est disponible pour les essais avec le simulateur de terminal ; l'URL de PROD sera livrée ensuite.
- **Format** : JSON (UTF-8), en-tête `Content-Type: application/json`.
- **Taille maximale d'une requête** : 2 Mo.
- **Schémas JSON officiels** (à utiliser pour valider côté borne) : [`schemas/transactions.v1.schema.json`](../schemas/transactions.v1.schema.json) et [`schemas/heartbeat.v1.schema.json`](../schemas/heartbeat.v1.schema.json). Ils acceptent `schema_version` `"1.0"` et `"1.1"`. Des exemples sont dans [`schemas/examples/`](../schemas/examples/).

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
| `gratuite` | non | Séance à 0 € : `mode_gratuit`, `code_staff`, `degrade` (terminal en panne, tirage offert) ou `reimpression`. Exige `moyen_paiement` = `aucun`. |
| `pikcloud_uuid` | non | Identifiant de la séance côté serveur web (`photo_uuid`). |
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
| `aucun` | Séance à 0 € (avec `statut: "accepte"`, `montant_ttc_centimes: 0` et, de préférence, `gratuite`). |
| `autre` | Moyen inconnu (ticket non retrouvé). |

Les séances à 0 € sont **acceptées** : elles ne font ni vente ni chiffre d'affaires, mais comptent dans l'activité et la consommation de papier du lieu.

**Interdit : aucune donnée de carte bancaire** (numéro, date d'expiration, nom du porteur…). Tout champ non prévu par le schéma est refusé, ce qui empêche qu'une telle donnée soit enregistrée par erreur. Les quatre derniers chiffres du ticket ne doivent pas être envoyés.

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
| `doublons` | Ventes déjà reçues à l'identique : ignorées, sans effet. |
| `rejetees` / `erreurs` | Ventes refusées, avec leur position dans le lot (`index`, à partir de 0) et le motif. Elles sont conservées côté plateforme dans la file d'erreurs : **inutile de les renvoyer telles quelles**. |
| `non_affectees` | Ventes reçues alors que la borne n'est affectée à aucun lieu à cette date. Elles sont gardées et signalées à Selfizee : rien à faire côté borne. |

Codes d'erreur par vente :

| Code | Cause |
|---|---|
| `SCHEMA_INVALIDE` | Champ manquant, mauvais format, champ non prévu, règle de cohérence non respectée (le `message` précise laquelle). |
| `MODULE_INCONNU` | `module.type` absent du référentiel de la plateforme. |
| `DEVISE_NON_GEREE` | Devise autre que `EUR`. |
| `CONFLIT_DOUBLON` | Ce `transaction_id` a déjà été reçu (ou figure deux fois dans le lot) **avec un contenu différent**. La vente d'origine n'est jamais écrasée. |
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

## 9. Points encore ouverts

- **Rapprochement** : un extrait réel du journal Hexapay et d'un relevé du prestataire permettra de confirmer les colonnes (TID, numéro d'autorisation, numéro de séquence) et les tolérances.
- **Séances à 0 €** : la plateforme les accepte. C'est à Selfizee de décider si les bornes les envoient.
