# Droits Konitys : correspondance avec les anciens rôles de la Régie

La Régie avait ses propres rôles (ADMIN, TECHNICIEN, COMMERCIAL, PARTENAIRE), lus dans Keycloak.
Ils sont remplacés par les droits de l'Admin Panel (voir `PERMISSIONS_APP_INTEGRATION.md`).
Ce tableau donne, pour chaque ancien rôle, les droits à cocher dans son profil pour que **rien ne change** pour les utilisateurs.

Les admins Keycloak (`is_admin`) passent partout : rien à cocher pour eux.
Pour donner tous les droits de la Régie à quelqu'un **sans** en faire un admin de la plateforme (cas d'Elen),
créer un profil « Régie – administrateur » avec toutes les clés cochées.

Profils suggérés : « Régie – administrateur », « Régie – technicien », « Régie – commercial » (ou le profil existant
« Konitys commercial »), « Régie – partenaire ».

| Clé | Administrateur | Technicien | Commercial | Partenaire |
|---|:-:|:-:|:-:|:-:|
| `app.access` | ✓ | ✓ | ✓ | ✓ |
| `pages.tableau_de_bord.view` | ✓ |  | ✓ |  |
| `pages.analyse_geo.view` | ✓ |  | ✓ |  |
| `pages.analyse.view` | ✓ |  | ✓ |  |
| `pages.comportements.view` | ✓ |  | ✓ |  |
| `pages.alertes.view` | ✓ | ✓ | ✓ |  |
| `pages.mentions.view` | ✓ | ✓ | ✓ |  |
| `pages.lieux.view` | ✓ | ✓ | ✓ |  |
| `pages.prospects.view` | ✓ |  | ✓ |  |
| `pages.bornes.view` | ✓ | ✓ |  |  |
| `pages.monitoring.view` | ✓ | ✓ |  |  |
| `pages.papier.view` | ✓ | ✓ |  |  |
| `pages.journal.view` | ✓ | ✓ |  |  |
| `pages.commissions.view` | ✓ |  |  |  |
| `pages.paiements.view` | ✓ |  |  |  |
| `pages.codes_remise.view` | ✓ |  |  |  |
| `pages.rapprochement.view` | ✓ |  |  |  |
| `pages.rentabilite.view` | ✓ |  |  |  |
| `pages.utilisateurs.view` | ✓ |  |  |  |
| `pages.parametres.view` | ✓ |  |  |  |
| `lieux.view_own` | ✓ | ✓ | ✓ | ✓ |
| `lieux.view_any` | ✓ | ✓ | ✓ ¹ |  |
| `lieux.create` | ✓ |  | ✓ |  |
| `lieux.edit` | ✓ |  | ✓ |  |
| `lieux.tarifs_edit` | ✓ |  | ✓ |  |
| `lieux.communication_edit` | ✓ |  |  |  |
| `ventes.view` | ✓ |  | ✓ | ✓ |
| `ventes.marges_view` | ✓ |  |  |  |
| `ventes.export` | ✓ |  | ✓ | ✓ |
| `suivi.view` | ✓ | ✓ | ✓ |  |
| `suivi.comment` | ✓ | ✓ | ✓ |  |
| `contexte.edit` | ✓ | ✓ | ✓ |  |
| `alertes.techniques_view` | ✓ | ✓ |  |  |
| `alertes.ventes_view` | ✓ |  | ✓ |  |
| `alertes.traiter` | ✓ | ✓ | ✓ |  |
| `alertes.regles_edit` | ✓ |  |  |  |
| `bornes.view` | ✓ | ✓ |  |  |
| `bornes.edit` | ✓ | ✓ |  |  |
| `interventions.edit` | ✓ | ✓ |  |  |
| `couts.edit` | ✓ | ✓ |  |  |
| `supervision.view` | ✓ | ✓ |  |  |
| `imports.manage` | ✓ | ✓ |  |  |
| `evenements.view` | ✓ |  |  |  |
| `evenements.edit` | ✓ |  |  |  |
| `illustrations.edit` | ✓ |  |  |  |
| `medias.view` | ✓ |  | ✓ | ✓ |
| `medias.manage` | ✓ |  |  |  |
| `commissions.view` | ✓ |  |  | ✓ ² |
| `commissions.edit` | ✓ |  |  |  |
| `paiements.view` | ✓ |  |  |  |
| `rapprochement.view` | ✓ |  |  |  |
| `rapprochement.edit` | ✓ |  |  |  |
| `rentabilite.view` | ✓ |  |  |  |
| `codes_remise.view` | ✓ |  |  |  |
| `codes_remise.edit` | ✓ |  |  |  |
| `prospects.view` | ✓ |  | ✓ |  |
| `prospects.edit` | ✓ |  | ✓ |  |
| `concurrents.edit` | ✓ |  | ✓ |  |
| `marketing.edit` | ✓ |  | ✓ |  |
| `utilisateurs.manage` | ✓ |  |  |  |
| `referentiel.edit` | ✓ |  |  |  |
| `cartes_test.edit` | ✓ |  |  |  |
| `demo.manage` | ✓ |  |  |  |

¹ Depuis le 09/11/2026, les commerciaux voient tous les lieux. Pour revenir à « ses lieux seulement », décocher `lieux.view_any`.
² Commissions de **son** lieu seulement (périmètre `lieux.view_own`).

Un partenaire ne voit que son lieu, rattaché dans la page Utilisateurs de la Régie (donnée propre à la Régie).
