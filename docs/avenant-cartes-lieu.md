# Avenant — cartes sans contact du lieu (Mifare) : réponse de la Régie

**État : EN PLACE côté Régie** (24/11/2026), en réponse à l'avenant proposé le 23/11/2026 par l'équipe borne.
Disponible sur l'API DEV dès son redéploiement, avec la migration `20261124090000_cartes_lieu`.

Les deux routes suivent le contrat de l'avenant (§ 3). Ce document liste seulement ce que la Régie précise ou
ajoute.

## 1. `POST ingest/v1/cartes/utiliser`

Corps accepté :

| Champ | Règle |
|---|---|
| `uid` | hexadécimal de 8, 14 ou 20 caractères ; espaces, `:` et `-` ignorés, casse indifférente |
| `type_carte` | facultatif, 2 caractères au plus (gardé pour information) |
| `montant_centimes` | entier de 0 à 1 000 000 |
| `nb` | entier de 1 à 100 |
| `utilisation_id` | 1 à 128 caractères, unique par borne |
| `session_code`, `evenement_code` | facultatifs, 32 et 16 caractères au plus |

Un corps mal formé reçoit `400 SCHEMA_INVALIDE`, noté au journal des bornes (type « Cartes du lieu »).

Ce que la Régie vérifie, dans cet ordre :

1. la carte est enregistrée, sinon `INCONNUE` ;
2. elle n'est pas désactivée, sinon `DESACTIVEE` ;
3. elle n'a pas passé son dernier jour de validité, heure de Paris, sinon `EXPIREE` ;
4. la borne est installée **maintenant** dans le lieu de la carte, sinon `LIEU`. Une borne en stock refuse donc
   toutes les cartes ;
5. le plafond du jour n'est pas dépassé, sinon `PLAFOND`. Il se compte en euros pour une carte qui débite et en
   tirages pour une carte de tirages offerts ;
6. pour une carte qui débite, le solde couvre tout le montant, sinon `SOLDE_INSUFFISANT`. Il n'y a pas de débit
   partiel.

Réponses :

- **Débit** : `{ ok: true, effet: "debite", montant_debite_centimes, solde_restant_centimes, libelle? }`.
- **Tirages offerts** : `{ ok: true, effet: "offert", libelle? }`, sans montant.
- **Refus** : `{ ok: false, raison, message }`.

**Raison ajoutée : `ANNULEE`.** La Régie la rend dans deux cas :

- l'annulation de la borne est arrivée **avant** l'utilisation, par exemple une requête encore en route quand la
  borne a renoncé. L'utilisation est alors refusée et rien n'est débité ;
- la borne renvoie le même `utilisation_id` après l'avoir annulé. Une utilisation annulée n'est jamais rendue
  acceptée, pour que rien ne soit servi après coup.

L'écran de l'invité reste « Carte non acceptée », comme pour toute raison inconnue de la borne.

Deux bornes qui présentent la même carte au même moment sont traitées l'une après l'autre. Elles ne peuvent donc
dépasser ni le solde ni le plafond.

## 2. `POST ingest/v1/cartes/annuler`

Conforme au § 3.2 de l'avenant :

- **carte débitée** : le montant est rendu au solde, réponse `annulee: true` ;
- **tirages offerts** : réponse `annulee: true`, et les tirages ne comptent plus dans le plafond du jour ;
- **utilisation refusée, inconnue ou déjà annulée** : réponse `annulee: false`.

## 3. Ventes

- **`carte_utilisation_id` est accepté** dans `ingest/v1/transactions`, en schéma 1.0 comme 1.1 : chaîne de 1 à
  128 caractères, facultative. La borne peut activer le réglage `regie/carteLieu=true`. La fiche d'une carte dans
  la Régie relie chaque utilisation à sa vente par ce champ.
- **Pas de valeur `carte_lieu`** pour `moyen_paiement` ni pour `gratuite` pour l'instant. Les ventes partent comme
  prévu au § 4 de l'avenant : `autre` pour une carte débitée, `aucun` avec `code_staff` pour des tirages offerts.

## 4. Côté Régie

- **Nouvelle page « Cartes du lieu »**, avec les droits `pages.cartes_lieu.view`, `cartes_lieu.view` et
  `cartes_lieu.edit`. Après le déploiement, cliquer sur « Rafraîchir » dans l'Admin Panel (schéma version 6), puis
  donner ces droits aux profils concernés.
- **Enregistrer une carte** : présenter la carte une fois à une borne du lieu. Elle apparaît dans « Cartes
  présentées mais pas encore enregistrées » avec son UID, et un clic sur « Enregistrer » ouvre la fiche avec l'UID
  déjà rempli.
- **Une carte appartient à un seul lieu.** Elle débite un solde ou offre les tirages. Elle peut avoir un plafond par
  jour, une date de fin de validité et des notes.
- **Le solde** se crédite ou se retire depuis la fiche de la carte, avec une note. Chaque mouvement est gardé avec
  son auteur.
- **Désactiver une carte** perdue, volée ou copiée : les bornes la refusent dès la présentation suivante.
- **L'historique** liste chaque présentation : acceptée ou refusée avec sa raison, montant, annulation éventuelle
  et vente reliée.
