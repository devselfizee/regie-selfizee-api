# Réponse aux avenants du 26/10/2026 (« parcours invité » et « ventes n° 2 »)

À l'attention du développeur du logiciel des bornes (`piktoo-QT-2026`).

Les deux avenants sont intégrés à la plateforme de suivi. La spécification à jour (« Synchronisation des bornes avec la plateforme de suivi ») décrit la nouvelle route au § 4 bis. Sources : `docs/synchronisation-bornes.md` et le schéma `schemas/parcours.v1.schema.json` du dépôt `regie-selfizee-api`.

## Parcours invité

| Demande | Réponse |
|---|---|
| Route `POST /ingest/v1/parcours` | **En place**, même authentification, mêmes réponses et mêmes règles de rattrapage que les ventes. Vos parcours en file peuvent partir dès le déploiement. |
| Schéma proposé | **Repris tel quel**, avec trois ajustements pour qu'il colle aux ventes : `borne_id` suit le même motif que les ventes ; les dates exigent le fuseau (`+01:00`, `+02:00` ou `Z`) ; `photo_uuid` accepte un UUID **avec ou sans tirets**, car le CDC de la page souvenir le décrit en 32 caractères hexadécimaux. Merci de vérifier le format réellement envoyé. |
| Réponse `200` | Les champs de votre avenant : `recus`, `crees`, `doublons`, `rejetees`, `non_affectees`, `erreurs[]` avec `parcours_id`. |
| Doublons et conflits | Renvoi identique : `doublons`. Contenu différent : `CONFLIT_DOUBLON`, l'original est gardé. Même `parcours_id` deux fois dans un lot : `DOUBLON_DANS_LE_LOT` pour le second. |
| Ligne mal formée | Rejetée seule (`SCHEMA_INVALIDE` dans `erreurs[]`), le reste du lot est enregistré, comme pour les ventes. |
| Rattachement au lieu | Au lieu où était la borne à `debut`. Si l'affectation est corrigée après coup, les parcours sont rattachés à nouveau, comme les ventes. |
| Exploitation | Entonnoir sur le tableau de bord et la fiche lieu : étapes, perte à chaque marche, issues, temps médians, hésitations, « +1 », photos d'appel, conversion par cadre. Le tableau de bord compte les **photos prises** à partir des parcours dès qu'il y en a. |

## Ventes n° 2

**Photo de la vente** : merci d'envoyer `pikcloud_uuid` (le `photo_uuid` PikCloud) sur chaque vente dont la photo a été enregistrée. La plateforme l'affiche dans le récapitulatif de la commande. Il est accepté avec ou sans tirets.

| # | Demande | Réponse |
|---|---|---|
| 1 | `carte_fin` (quatre derniers chiffres) | **Accepté** (décision de Selfizee du 27/10/2026) : 4 chiffres, seulement avec `cb` ou `sans_contact`. Vous pouvez livrer. Ils ne sont visibles que des administrateurs, dans le récapitulatif de la commande, et permettent de retrouver une vente par ces chiffres. |
| 2 | Paiement avec le téléphone | Noté. `sans_contact` s'affiche « sans contact (carte ou téléphone) », et « Téléphone » n'apparaît plus comme une catégorie vide. Si votre essai au banc permet de reconnaître le téléphone, `mobile` est déjà accepté. |
| 3 | Valeur `sans_tirage` de `gratuite` | **Acceptée** (schéma 1.1). Vous pouvez livrer : `gratuite` est alors présent pour toute séance `aucun`. Ces séances ne comptent ni dans le CA ni dans les tirages. |
| § 4.2 | Libellés | **Repris** sur la page Ventes : carte insérée, sans contact (carte ou téléphone), paiement en ligne, ticket non retrouvé, gratuit avec son motif, sans réponse du terminal, tirage offert (non débité), à rapprocher. Les cartes insérées et le sans contact sont regroupés en « carte bancaire » dans les statistiques, à la demande de Selfizee. |
