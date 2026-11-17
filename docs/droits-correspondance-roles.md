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
| `lieux.commercial_edit` | ✓ |  |  |  |
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
| `souvenir.contacts_view` | ✓ |  | ✓ | ✓ |
| `commissions.view` | ✓ |  |  | ✓ ² |
| `commissions.edit` | ✓ |  |  |  |
| `paiements.view` | ✓ |  |  |  |
| `paiements.rembourser` | ✓ |  |  |  |
| `rapprochement.view` | ✓ |  |  |  |
| `rapprochement.edit` | ✓ |  |  |  |
| `rentabilite.view` | ✓ |  |  |  |
| `rentabilite.edit` | ✓ |  |  |  |
| `codes_remise.view` | ✓ |  |  |  |
| `codes_remise.edit` | ✓ |  |  |  |
| `prospects.view` | ✓ |  | ✓ |  |
| `prospects.edit` | ✓ |  | ✓ |  |
| `concurrents.edit` | ✓ |  | ✓ |  |
| `concurrents.delete` | ✓ |  |  |  |
| `marketing.edit` | ✓ |  | ✓ |  |
| `utilisateurs.manage` | ✓ |  |  |  |
| `referentiel.edit` | ✓ |  |  |  |
| `cartes_test.edit` | ✓ |  |  |  |
| `demo.manage` | ✓ |  |  |  |

¹ Depuis le 09/11/2026, les commerciaux voient tous les lieux. Pour revenir à « ses lieux seulement », décocher `lieux.view_any`.
² Commissions de **son** lieu seulement (périmètre `lieux.view_own`).

Un partenaire ne voit que son lieu, rattaché dans la page Utilisateurs de la Régie (donnée propre à la Régie).

## Clients : accès à un ou plusieurs lieux (demande du 17/11/2026)

Un client (le gérant d'un lieu, un groupe qui en a plusieurs) se rattache à **un ou plusieurs lieux** dans la page
Utilisateurs de la Régie : c'est son périmètre (« ses lieux », clé `lieux.view_own`). **Ce qu'il peut y faire** se
règle, comme pour tout le monde, par son profil dans l'Admin Panel. Trois profils à créer, du plus léger au plus complet :

| Clé | Client – chiffres | Client – complet | Client – événements |
|---|:-:|:-:|:-:|
| `app.access` | ✓ | ✓ | ✓ |
| `lieux.view_own` | ✓ | ✓ | ✓ |
| `ventes.view` | ✓ | ✓ | ✓ |
| `ventes.export` |  | ✓ | ✓ |
| `paiements.view` |  | ✓ | ✓ |
| `medias.view` |  | ✓ | ✓ |
| `souvenir.contacts_view` |  | ✓ | ✓ |
| `commissions.view` |  | ✓ | ✓ |
| `evenements.view` |  | ✓ | ✓ |
| `evenements.edit` |  |  | ✓ |

« Client – chiffres » : les statistiques de ses lieux, rien d'autre. « Client – complet » : en plus les ventes une à une,
les photos, les contacts laissés par les invités, ses reversements, et la configuration de ses bornes en lecture.
« Client – événements » : il crée et publie lui-même les événements de ses bornes.
Ne jamais cocher `lieux.view_any` pour un client : il verrait tous les lieux. Le menu du client se limite à
« Mon lieu » (un lieu) ou « Mes lieux » (un lien par lieu) tant qu'il n'a pas `pages.lieux.view`.

## Apporteurs d'affaires (demande du 17/11/2026)

Un apporteur (un ami, une antenne, n'importe qui qui a recommandé un lieu) touche un % des ventes des lieux qu'il a
apportés. Il se rattache à ses lieux, avec son taux, dans la page **Apporteurs** de la Régie (droit `apporteurs.manage`).
Son accès est très léger : la page « Mes apports » (chiffre généré par chaque lieu et sa commission, mois par mois),
et rien d'autre — ni photos, ni fiches lieux.

| Clé | Apporteur d'affaires |
|---|:-:|
| `app.access` | ✓ |
| `pages.mes_apports.view` | ✓ |
| `apporteurs.view_own` | ✓ |

Pour ceux qui gèrent les apporteurs (administrateur) : `pages.apporteurs.view` et `apporteurs.manage`.

Destinataires des alertes : ils ne dépendent plus d'un rôle. Dans la page Utilisateurs de la Régie, deux cases par personne :
« E-mails des alertes » (alertes Warning et Critique, et récapitulatif quotidien) et « SMS des alertes » (alertes critiques).
À la bascule, les anciens admins et techniciens sont abonnés aux e-mails. Le commercial responsable d'un lieu reçoit en plus
les e-mails des alertes de vente de ce lieu.
