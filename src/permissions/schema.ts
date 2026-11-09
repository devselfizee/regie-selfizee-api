// Droits Konitys de la Régie — voir docs/PERMISSIONS_APP_INTEGRATION.md
// Schéma lu par le gateway (Admin Panel → Profils & Droits → « Rafraîchir ») sur GET /adminpanel/permissions-schema.
// Règles : ne jamais supprimer ni renommer une clé (droits orphelins en base) ; incrémenter `version` à chaque modification.

export const APP_KEY = "regie";

type Droit = { key: string; label: string; description?: string };
type Groupe = { key: string; label: string; permissions: Droit[] };

const GROUPES: Groupe[] = [
  { key: "access", label: "Accès à l'application", permissions: [{ key: "app.access", label: "Accéder à la Régie" }] },
  {
    key: "pages",
    label: "Navigation (pages)",
    permissions: [
      { key: "pages.tableau_de_bord.view", label: "Voir le tableau de bord" },
      { key: "pages.analyse_geo.view", label: "Voir l'analyse géographique" },
      { key: "pages.analyse.view", label: "Voir l'analyse" },
      { key: "pages.comportements.view", label: "Voir les comportements" },
      { key: "pages.alertes.view", label: "Voir la page des alertes" },
      { key: "pages.mentions.view", label: "Voir « Mes mentions »" },
      { key: "pages.lieux.view", label: "Voir la liste des lieux" },
      { key: "pages.prospects.view", label: "Voir les prospects" },
      { key: "pages.bornes.view", label: "Voir la liste des bornes" },
      { key: "pages.monitoring.view", label: "Voir le monitoring live" },
      { key: "pages.papier.view", label: "Voir le papier des bornes" },
      { key: "pages.journal.view", label: "Voir le journal des bornes (suivi technique)" },
      { key: "pages.commissions.view", label: "Voir les commissions" },
      { key: "pages.paiements.view", label: "Voir les paiements" },
      { key: "pages.codes_remise.view", label: "Voir les codes de remise" },
      { key: "pages.rapprochement.view", label: "Voir le rapprochement" },
      { key: "pages.rentabilite.view", label: "Voir la rentabilité" },
      { key: "pages.utilisateurs.view", label: "Voir les utilisateurs" },
      { key: "pages.parametres.view", label: "Voir les paramètres" },
    ],
  },
  {
    key: "lieux",
    label: "Lieux",
    permissions: [
      { key: "lieux.view_own", label: "Voir ses lieux", description: "Ceux dont il est le commercial responsable ; pour un partenaire, son lieu." },
      { key: "lieux.view_any", label: "Voir tous les lieux" },
      { key: "lieux.create", label: "Créer un lieu" },
      { key: "lieux.edit", label: "Modifier un lieu", description: "Fiche, horaires, contacts, saisons et fermetures." },
      { key: "lieux.tarifs_edit", label: "Modifier le tarif d'un lieu" },
      { key: "lieux.communication_edit", label: "Modifier la communication d'un lieu", description: "Nom affiché, avis, réseaux, assistance (repris par la borne)." },
    ],
  },
  {
    key: "ventes",
    label: "Chiffres et statistiques",
    permissions: [
      { key: "ventes.view", label: "Voir le chiffre d'affaires et les statistiques", description: "Tableau de bord, analyse, comportements, onglets Statistiques et Comportement d'un lieu." },
      { key: "ventes.marges_view", label: "Voir les marges et les commissions dans les statistiques" },
      { key: "ventes.export", label: "Exporter les chiffres (Excel, PDF)" },
    ],
  },
  {
    key: "suivi",
    label: "Suivi des lieux",
    permissions: [
      { key: "suivi.view", label: "Voir le suivi d'un lieu (timeline)" },
      { key: "suivi.comment", label: "Commenter et mentionner dans le suivi" },
      { key: "contexte.edit", label: "Ajouter des événements au journal d'un lieu", description: "Soirée spéciale, travaux, déplacement de la borne…" },
    ],
  },
  {
    key: "alertes",
    label: "Alertes",
    permissions: [
      { key: "alertes.techniques_view", label: "Voir les alertes techniques", description: "Borne muette, consommables, refus de paiement…" },
      { key: "alertes.ventes_view", label: "Voir les alertes de vente", description: "Baisse de CA, zéro vente, pic suspect, vente hors horaires." },
      { key: "alertes.traiter", label: "Prendre en charge, résoudre, ignorer et commenter une alerte" },
      { key: "alertes.regles_edit", label: "Modifier les règles d'alerte" },
    ],
  },
  {
    key: "bornes",
    label: "Bornes et parc",
    permissions: [
      { key: "bornes.view", label: "Voir les bornes" },
      { key: "bornes.edit", label: "Créer et modifier une borne, l'affecter, renouveler sa clé" },
      { key: "interventions.edit", label: "Saisir les interventions sur les bornes" },
      { key: "couts.edit", label: "Saisir les coûts des bornes" },
      { key: "supervision.view", label: "Voir l'état en direct des bornes (monitoring, papier)" },
      { key: "imports.manage", label: "Consulter et traiter les envois des bornes", description: "Journal des bornes, erreurs d'import, rejouer un lot." },
    ],
  },
  {
    key: "evenements",
    label: "Configuration des bornes (événements)",
    permissions: [
      { key: "evenements.view", label: "Voir la configuration et les événements d'un lieu" },
      { key: "evenements.edit", label: "Créer, modifier et publier les événements, cadres et illustrations" },
      { key: "illustrations.edit", label: "Gérer la bibliothèque des séries d'illustrations" },
    ],
  },
  {
    key: "medias",
    label: "Photos et vidéos",
    permissions: [
      { key: "medias.view", label: "Voir les photos et vidéos des séances" },
      { key: "medias.manage", label: "Relancer les téléchargements de médias" },
    ],
  },
  {
    key: "argent",
    label: "Argent",
    permissions: [
      { key: "commissions.view", label: "Voir les commissions et les contrats" },
      { key: "commissions.edit", label: "Gérer les contrats, reversements et relevés de commission" },
      { key: "paiements.view", label: "Voir le détail des paiements et des ventes" },
      { key: "rapprochement.view", label: "Voir le rapprochement monétique" },
      { key: "rapprochement.edit", label: "Importer des relevés et rapprocher" },
      { key: "rentabilite.view", label: "Voir la rentabilité des bornes" },
      { key: "codes_remise.view", label: "Voir les codes de remise" },
      { key: "codes_remise.edit", label: "Générer, désactiver et supprimer des codes de remise" },
    ],
  },
  {
    key: "commercial",
    label: "Commercial",
    permissions: [
      { key: "prospects.view", label: "Voir les prospects et les emplacements des concurrents" },
      { key: "prospects.edit", label: "Créer et modifier des prospects" },
      { key: "concurrents.edit", label: "Gérer les concurrents et leurs emplacements" },
      { key: "marketing.edit", label: "Modifier le calendrier marketing" },
    ],
  },
  {
    key: "administration",
    label: "Administration",
    permissions: [
      { key: "utilisateurs.manage", label: "Gérer les utilisateurs de la Régie", description: "Ajout, lieu d'un partenaire, SMS des alertes, désactivation." },
      { key: "referentiel.edit", label: "Modifier les listes et réglages (paramètres)" },
      { key: "cartes_test.edit", label: "Gérer les cartes bancaires de test" },
      { key: "demo.manage", label: "Charger ou effacer les données de démonstration" },
    ],
  },
];

export function buildPermissionsSchema() {
  return { app: APP_KEY, label: "Régie Selfizee", version: 1, groups: GROUPES };
}

/** Toutes les clés du schéma (contrôle des fautes de frappe dans les tests) */
export const CLES = new Set(GROUPES.flatMap((g) => g.permissions.map((p) => p.key)));
