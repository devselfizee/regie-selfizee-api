# Avenant — cartes sans contact du lieu (Mifare) : réponse de la Régie

**État : EN PLACE côté Régie** (24/11/2026), en réponse à l'avenant de l'équipe borne, **version 2** (revue de
sécurité du 23/11/2026, § 2 bis). Disponible sur l'API DEV dès son redéploiement, avec les migrations
`20261124090000_cartes_lieu` et `20261124150000_cartes_lieu_avenant_v2`.

Les deux routes suivent le contrat de l'avenant (§ 3). Ce document liste seulement ce que la Régie précise ou
ajoute.

Choix confirmés par l'exploitant le 24/11/2026 : une carte appartient à un seul lieu, la raison de refus
`ANNULEE` (§ 1), pas de valeur `carte_lieu` dans les ventes (§ 3).

## 1. `POST ingest/v1/cartes/utiliser`

Corps accepté :

| Champ | Règle |
|---|---|
| `uid` | hexadécimal de 8, 14 ou 20 caractères ; espaces, `:` et `-` ignorés, casse indifférente |
| `type_carte` | facultatif, 2 caractères au plus (gardé pour information) |
| `montant_centimes` | entier de **1** à 1 000 000 : **0 est refusé** (`400`) |
| `nb` | entier de 1 à 100 |
| `utilisation_id` | 1 à 128 caractères, unique par borne |
| `session_code`, `evenement_code` | facultatifs, 32 et 16 caractères au plus |

Un corps mal formé reçoit `400 SCHEMA_INVALIDE`, noté au journal des bornes (type « Cartes du lieu »).

Ce que la Régie vérifie, dans cet ordre :

1. la carte est enregistrée, sinon `INCONNUE` ;
2. elle n'est pas désactivée, sinon `DESACTIVEE` ;
3. elle n'a pas passé sa dernière nuit de validité, sinon `EXPIREE` ;
4. la borne est installée **maintenant** dans le lieu de la carte, sinon `LIEU`. Une borne en stock refuse donc
   toutes les cartes ;
5. **le montant ne dépasse pas les tarifs**, sinon `MONTANT` (raison ajoutée). Plafond retenu : `nb` fois le prix
   unitaire le plus haut des tarifs du lieu et de l'événement `evenement_code` s'il est de ce lieu (premier palier
   ou « +1 »). Un code promo ne fait que baisser le montant, il passe donc toujours ;
6. le plafond de la nuit n'est pas dépassé, sinon `PLAFOND`. Une carte peut avoir un plafond en nombre
   d'utilisations, et en plus un plafond en euros si elle débite, ou en tirages si elle offre ;
7. pour une carte qui débite, le solde couvre tout le montant, sinon `SOLDE_INSUFFISANT`. Il n'y a pas de débit
   partiel.

**Nuit d'exploitation** : de 6 h à 6 h, heure de Paris. Une soirée qui passe minuit compte pour une seule nuit,
pour les plafonds comme pour la date de fin de validité (une carte valable jusqu'au 23 passe jusqu'au 24 à 6 h).

Réponses :

- **Débit** : `{ ok: true, effet: "debite", montant_debite_centimes, libelle? }`. Le montant débité est toujours
  égal au montant demandé. **Le solde restant n'est pas renvoyé** (§ 2 bis : la borne n'en a pas besoin).
- **Tirages offerts** : `{ ok: true, effet: "offert", libelle? }`, sans montant.
- **Refus** : `{ ok: false, raison, message }`. Aucune réponse ne contient l'UID.

**Raison ajoutée : `ANNULEE`.** La Régie la rend dans deux cas :

- l'annulation de la borne est arrivée **avant** l'utilisation, par exemple une requête encore en route quand la
  borne a renoncé. L'utilisation est alors refusée et rien n'est débité ;
- la borne renvoie le même `utilisation_id` après l'avoir annulé. Une utilisation annulée n'est jamais rendue
  acceptée, pour que rien ne soit servi après coup.

`ANNULEE` et `MONTANT` s'affichent « Carte non acceptée », comme toute raison inconnue de la borne.

**Renvois.** Un renvoi du même `utilisation_id` rend la réponse du premier appel sans rien débiter. Si le premier
appel est encore en traitement, le renvoi attend sa fin et rend son résultat : la Régie ne répond pas `409`. Même
`utilisation_id` avec un autre `uid`, un autre montant ou un autre `nb` : `400 UTILISATION_DIFFERENTE`.

**Limite d'essais.** Au-delà de **5 refus en une minute** sur une même borne, la route répond
`429 TROP_DE_REFUS` sans regarder la carte, jusqu'à ce que la minute soit passée.

Deux bornes qui présentent la même carte au même moment sont traitées l'une après l'autre. Elles ne peuvent donc
dépasser ni le solde ni le plafond.

## 2. `POST ingest/v1/cartes/annuler`

Conforme au § 3.2 de l'avenant :

- **les cinq raisons** sont acceptées : `tirage_non_sorti`, `sans_reponse`, `reponse_invalide`, `reponse_tardive`,
  `arret_borne`. `le` est accepté ; l'heure de réception est celle qui est gardée ;
- **carte débitée** : le montant est rendu au solde, réponse `annulee: true` ;
- **tirages offerts** : réponse `annulee: true`, et l'utilisation ne compte plus dans le plafond de la nuit ;
- **utilisation refusée ou déjà annulée** : réponse `annulee: false` ;
- **utilisation inconnue** : réponse `annulee: false`, et l'`utilisation_id` est retenu : un `utiliser` qui le
  porte ensuite est refusé avec `ANNULEE` ;
- **plus de 7 jours après l'utilisation** : réponse `annulee: false`, rien n'est rendu, et la Régie le note dans
  son journal.

Une annulation n'est acceptée que de la borne qui a fait l'utilisation. La Régie reconnaît une borne par sa fiche,
pas par son identifiant : une borne renommée garde ses utilisations et peut les annuler. Chaque annulation garde
sa raison et son heure, visibles sur la fiche de la carte.

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
- **Une carte appartient à un seul lieu.** Elle débite un solde ou offre les tirages. Elle peut avoir des plafonds
  par nuit (euros ou tirages, et nombre d'utilisations), une date de fin de validité et des notes.
- **Le solde** se crédite ou se retire depuis la fiche de la carte, avec une note. Chaque mouvement est gardé avec
  son auteur.
- **Désactiver une carte** perdue, volée ou copiée : les bornes la refusent dès la présentation suivante.
- **L'historique** liste chaque présentation : acceptée ou refusée avec sa raison, montant, annulation éventuelle
  et vente reliée.
