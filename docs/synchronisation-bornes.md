# Synchronisation des bornes avec la plateforme de suivi — API v1

Ce document s'adresse au développeur du logiciel des bornes (Ma Trombine, Prestige). Il décrit comment une borne envoie ses **ventes** et son **état** (heartbeat) à la plateforme de suivi Régie.

La synchronisation est **directe : borne → plateforme de suivi**, sans passer par Pikcloud ni Booth. La borne n'envoie que son journal de ventes et son état. Elle n'envoie ni photos ni données personnelles.

## 1. Vue d'ensemble

| Envoi | Route | Fréquence |
|---|---|---|
| Ventes | `POST /ingest/v1/transactions` | Après chaque vente (ou par petits lots), plus le rattrapage après une coupure |
| État de la borne | `POST /ingest/v1/heartbeats` | Toutes les **5 minutes**, même sans vente |

- **URL de base** : fournie par Selfizee (ex. `https://api-regie.<domaine>`). Elle sera obligatoirement en **HTTPS** avant la mise en service des bornes.
- **Format** : JSON (UTF-8), en-tête `Content-Type: application/json`.
- **Taille maximale d'une requête** : 2 Mo.
- **Schémas JSON officiels** (à utiliser pour valider côté borne) : [`schemas/transactions.v1.schema.json`](../schemas/transactions.v1.schema.json) et [`schemas/heartbeat.v1.schema.json`](../schemas/heartbeat.v1.schema.json). Des exemples sont dans [`schemas/examples/`](../schemas/examples/).

## 2. Authentification

Chaque borne a **sa propre clé API**, envoyée dans chaque requête :

```
Authorization: Bearer rgs_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- La clé est générée sur la plateforme (page **Bornes** → « Nouvelle borne » ou « Nouvelle clé »). Elle n'est affichée qu'**une seule fois** : il faut la stocker dans la configuration de la borne, de façon protégée.
- Le champ `borne_id` envoyé dans le JSON doit être **exactement l'identifiant de la borne à qui appartient la clé** (ex. `MT-0042`). Sinon la requête est refusée (403).
- Si la clé est régénérée sur la plateforme, l'ancienne cesse immédiatement de fonctionner. La borne doit alors garder ses ventes en attente jusqu'à l'installation de la nouvelle clé.

## 3. Envoi des ventes

### Requête

```
POST /ingest/v1/transactions
Authorization: Bearer <clé de la borne>
Content-Type: application/json
```

```json
{
  "schema_version": "1.0",
  "borne_id": "MT-0042",
  "envoye_le": "2026-10-05T23:15:02+02:00",
  "logiciel_version": "3.4.1",
  "rattrapage": false,
  "transactions": [
    {
      "transaction_id": "ING-20261005-000184",
      "horodatage": "2026-10-05T22:47:31+02:00",
      "montant_ttc_centimes": 800,
      "devise": "EUR",
      "statut": "accepte",
      "module": { "type": "INGENICO_SELF_2000", "numero_serie": "SELF2K-19A77310" },
      "moyen_paiement": "sans_contact",
      "reference_monetique": "AUT-554821",
      "produit": { "code": "BANDE_4", "libelle": "Bande 4 photos", "nb_tirages": 2 }
    }
  ]
}
```

### Enveloppe du lot

| Champ | Obligatoire | Description |
|---|---|---|
| `schema_version` | oui | Toujours `"1.0"` pour cette version. |
| `borne_id` | oui | Identifiant de la borne : majuscules, chiffres, `-` et `_` (3 à 64 caractères). |
| `envoye_le` | oui | Date et heure d'envoi du lot, **avec fuseau** (voir § Horodatages). |
| `logiciel_version` | oui | Version du logiciel de la borne. |
| `rattrapage` | non | `true` quand la borne renvoie un historique après une coupure. |
| `transactions` | oui | De **1 à 500** ventes. |

### Une vente

| Champ | Obligatoire | Description |
|---|---|---|
| `transaction_id` | oui | Identifiant de la transaction **donné par le module de paiement**, unique pour la borne. C'est la clé anti-doublon. |
| `horodatage` | oui | Date et heure de la vente, **avec fuseau**. |
| `montant_ttc_centimes` | oui | Montant TTC en **centimes, nombre entier** : `800` = 8,00 €. Toujours positif, y compris pour un remboursement. |
| `taux_tva_pct` | non | Taux de TVA appliqué (ex. `20`). Sinon, la plateforme applique 20 %. |
| `devise` | oui | `"EUR"` (seule devise gérée pour l'instant). |
| `statut` | oui | `"accepte"`, `"refuse"`, `"annule"` ou `"rembourse"`. **Envoyer aussi les paiements refusés** : ils servent au taux de refus et aux alertes. |
| `transaction_origine_id` | si remboursement | Pour un remboursement (ou une annulation après coup) : `transaction_id` de la vente d'origine. **Obligatoire si `statut` = `rembourse`.** |
| `module.type` | oui | Code du type de module de paiement : `INGENICO_SELF_2000`, `MONNAYEUR`, `STRIPE_TERMINAL`… Un code inconnu de la plateforme est rejeté : demander à Selfizee de l'ajouter. |
| `module.numero_serie` | non | Numéro de série du module. |
| `moyen_paiement` | oui | `"cb"` (carte insérée), `"sans_contact"`, `"especes"`, `"mobile"` (Apple Pay / Google Pay) ou `"autre"`. |
| `reference_monetique` | non | Référence du prestataire (n° d'autorisation…), utilisée pour le rapprochement avec les relevés Ingenico. **Interdite pour les espèces.** |
| `produit.code` | oui | Code de la formule vendue (ex. `BANDE_4`). |
| `produit.libelle` | non | Libellé lisible de la formule. |
| `produit.nb_tirages` | oui | Nombre de tirages imprimés (0 à 100 ; `0` pour un refus). |

**Interdit : aucune donnée de carte bancaire** (numéro, date d'expiration, nom du porteur…). Tout champ non prévu par le schéma est refusé, ce qui empêche qu'une telle donnée soit enregistrée par erreur.

### Remboursements et annulations

Un remboursement est une **nouvelle vente**, avec son propre `transaction_id`, `statut: "rembourse"` et `transaction_origine_id` pointant vers la vente d'origine. Il ne faut **pas** renvoyer la vente d'origine avec un statut modifié : elle serait rejetée (`CONFLIT_DOUBLON`).

### Horodatages

- Format RFC 3339 **avec fuseau obligatoire** : `2026-10-05T22:47:31+02:00` ou `2026-10-05T20:47:31Z`. Une date sans fuseau est rejetée.
- L'horloge de la borne doit être **synchronisée (NTP)**. C'est la date de la vente qui détermine à quel lieu elle est attribuée : une borne déplacée d'un camping vers un bar.

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
    { "index": 2, "transaction_id": "MON-000912", "code": "MODULE_INCONNU", "message": "Type de module \"MONNAYEUR_X\" absent du référentiel" }
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
| `SCHEMA_INVALIDE` | Champ manquant, mauvais format, champ non prévu (le `message` précise lequel). |
| `MODULE_INCONNU` | `module.type` absent du référentiel de la plateforme. |
| `DEVISE_NON_GEREE` | Devise autre que `EUR`. |
| `CONFLIT_DOUBLON` | Ce `transaction_id` a déjà été reçu **avec un contenu différent** (montant, statut, date…). La vente d'origine n'est jamais écrasée. |

## 4. Envoi du heartbeat (état de la borne)

Toutes les **5 minutes**, même sans vente. C'est ce qui permet de distinguer « pas de client » de « borne en panne ».

```
POST /ingest/v1/heartbeats
Authorization: Bearer <clé de la borne>
Content-Type: application/json
```

```json
{
  "schema_version": "1.0",
  "borne_id": "MT-0042",
  "heartbeats": [
    {
      "horodatage": "2026-10-05T23:15:00+02:00",
      "logiciel_version": "3.4.1",
      "papier_restant": 310,
      "ruban_restant": 316,
      "imprimante_ok": false,
      "module_paiement_ok": true,
      "erreurs": [{ "code": "PRN_JAM", "message": "Bourrage papier", "composant": "imprimante" }]
    }
  ]
}
```

| Champ | Obligatoire | Description |
|---|---|---|
| `horodatage` | oui | Moment de la mesure, avec fuseau. |
| `logiciel_version` | oui | Version du logiciel. |
| `papier_restant`, `ruban_restant` | non | Nombre de tirages restants. Servira aux alertes consommables. |
| `imprimante_ok`, `module_paiement_ok` | non | État des périphériques. |
| `erreurs` | non | Erreurs en cours : `code`, `message`, `composant` (`imprimante`, `module_paiement`, `camera`, `ecran`, `reseau`, `logiciel`, `autre`). |

Un lot peut contenir jusqu'à **2 000** heartbeats (rattrapage). Réponse : `200 OK` avec `{ "recus": 2, "crees": 2, "doublons": 0 }`. Un heartbeat déjà reçu (même borne, même horodatage) est ignoré.

## 5. Codes de réponse HTTP et comportement attendu

| Code | Signification | Que doit faire la borne |
|---|---|---|
| `200` | Lot traité (voir `erreurs` pour les lignes rejetées). | Retirer **tout le lot** de la file d'attente locale. |
| `400` `SCHEMA_INVALIDE` / `JSON_INVALIDE` | L'enveloppe du lot est invalide (ex. `transactions` vide, `borne_id` mal formé, JSON illisible). | **Ne pas renvoyer en boucle** : journaliser et corriger le logiciel. Un lot `SCHEMA_INVALIDE` est conservé dans la file d'erreurs de la plateforme ; un JSON illisible (`JSON_INVALIDE`) ne l'est pas. |
| `401` `CLE_INVALIDE` | Clé absente ou invalide. | Garder les ventes en attente, signaler le problème (clé à réinstaller). |
| `403` `BORNE_DIFFERENTE` | `borne_id` ne correspond pas à la clé. | Corriger la configuration ; garder les ventes en attente. |
| `403` `BORNE_REFORMEE` | Borne désactivée sur la plateforme. | Arrêter les envois. |
| `413` `LOT_TROP_GROS` | Requête de plus de 2 Mo. | Découper en lots plus petits. |
| `5xx`, délai dépassé, pas de réseau | Problème temporaire. | **Réessayer plus tard** (voir ci-dessous). |

## 6. Fiabilité : file d'attente, renvois, rattrapage

Ce sont les points les plus importants : la plateforme sert à calculer ce qui est reversé aux lieux, aucune vente ne doit être perdue.

1. **File d'attente locale persistante.** Chaque vente est écrite dans une file sur le disque de la borne (SQLite, fichier…) **avant** toute tentative d'envoi. Elle survit à un redémarrage ou à une coupure de courant.
2. **Retrait de la file seulement après un `200`.** Tant que la plateforme n'a pas répondu `200`, la vente reste en file.
3. **Renvois sans risque.** La plateforme ignore les doublons (même `borne_id` + même `transaction_id` avec le même contenu). En cas de doute (délai dépassé, réponse non reçue), **renvoyer** : une vente comptée deux fois est impossible.
4. **Délais entre les essais** : en cas d'échec réseau ou de `5xx`, attendre de plus en plus longtemps (ex. 30 s, 1 min, 2 min, 5 min, puis toutes les 15 min), avec une petite part d'aléatoire pour que toutes les bornes ne réessaient pas en même temps. Délai d'attente d'une requête : 30 s.
5. **Rattrapage après une coupure.** Au retour du réseau, envoyer la file dans l'**ordre chronologique**, par lots de **500 ventes maximum**, un lot à la fois, avec `"rattrapage": true`. Les heartbeats en retard peuvent être renvoyés de la même façon (ou abandonnés au-delà de 24 h).
6. **`transaction_id` stable.** Le même `transaction_id` doit toujours désigner la même vente, avec les mêmes valeurs (montant, date, statut, moyen, formule). Ne jamais réutiliser un identifiant pour une autre vente.

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

1. Selfizee crée la borne sur la plateforme (identifiant, gamme, module de paiement) et récupère sa clé API.
2. La clé et l'identifiant sont installés dans la configuration de la borne.
3. Selfizee affecte la borne à son lieu (avec la date de début).
4. Vérification : la borne apparaît **« En ligne »** dans la page Bornes dans les 5 minutes (heartbeat), puis une vente test apparaît dans les statistiques du lieu.

## 9. Points encore ouverts

- **Lien avec Pikcloud** : ajout possible d'un champ optionnel avec l'identifiant de la session ou de l'événement Pikcloud, pour relier une vente à ses photos. À définir selon les identifiants dont la borne dispose au moment de la vente.
- **Journal Ingenico Self 2000** : à confirmer sur un exemple réel (identifiant de transaction, distinction carte insérée / sans contact / mobile, numéro d'autorisation).
- **HTTPS** : obligatoire avant la mise en service des vraies bornes. L'URL définitive sera communiquée.
