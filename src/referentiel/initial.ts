import type { RefCategorie } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

// Valeurs de départ des listes administrables, gammes et types de module.
// Ajoutées au démarrage de l'API si elles manquent ; jamais modifiées ensuite
// (un admin peut les renommer, les désactiver ou en ajouter depuis l'application).

const LISTES: Record<RefCategorie, [code: string, libelle: string][]> = {
  TYPE_LIEU: [
    ["CAMPING", "Camping"], ["BOITE_DE_NUIT", "Boîte de nuit"], ["BAR", "Bar"],
    ["RESTAURANT", "Restaurant"], ["LIEU_TOURISTIQUE", "Lieu touristique"],
    ["CENTRE_COMMERCIAL", "Centre commercial"], ["CINEMA", "Cinéma"],
    ["BOWLING", "Bowling"], ["PARC_LOISIRS", "Parc de loisirs"],
  ],
  SOUS_TYPE_LIEU: [],
  STANDING: [["ECO", "Économique"], ["STANDARD", "Standard"], ["PREMIUM", "Premium"], ["LUXE", "Luxe"]],
  CLIENTELE: [
    ["FAMILLES", "Familles"], ["TOURISTES", "Touristes"], ["ETUDIANTS", "Étudiants"],
    ["18_25", "18-25 ans"], ["25_40", "25-40 ans"], ["SENIORS", "Seniors"],
  ],
  ZONE_GEO: [
    ["URBAINE", "Urbaine"], ["PERIURBAINE", "Périurbaine"], ["RURALE", "Rurale"],
    ["LITTORAL", "Littoral"], ["MONTAGNE", "Montagne"],
  ],
  TAILLE_COMMUNE: [
    ["MOINS_5K", "< 5 000 hab."], ["5K_20K", "5 000 – 20 000"], ["20K_100K", "20 000 – 100 000"],
    ["PLUS_100K", "> 100 000"],
  ],
  EMPLACEMENT_ZONE: [["ENTREE", "Entrée"], ["PISTE", "Piste"], ["TERRASSE", "Terrasse"], ["ACCUEIL", "Accueil"], ["COULOIR", "Couloir / passage"]],
  ECLAIRAGE: [["FAIBLE", "Faible"], ["MOYEN", "Moyen"], ["BON", "Bon"]],
  ORIGINE_LEAD: [["PROSPECTION", "Prospection terrain"], ["RECOMMANDATION", "Recommandation"], ["ENTRANT", "Demande entrante"], ["SALON", "Salon"]],
  TYPE_EVENEMENT: [["SOIREE", "Soirée spéciale"], ["DEPLACEMENT", "Déplacement de la borne"], ["TRAVAUX", "Travaux"], ["PRIX", "Changement de prix"]],
};

const SOUS_TYPES: [parent: string, code: string, libelle: string][] = [
  ["CAMPING", "CAMPING_3", "Camping 3*"], ["CAMPING", "CAMPING_4_5", "Camping 4-5*"],
  ["BAR", "BAR_DANSANT", "Bar dansant"], ["BAR", "PUB", "Pub"],
];

/** Idempotent : crée seulement ce qui manque. */
export async function initialiserReferentiel() {
  for (const [categorie, valeurs] of Object.entries(LISTES) as [RefCategorie, [string, string][]][]) {
    for (const [ordre, [code, libelle]] of valeurs.entries()) {
      await prisma.refValeur.upsert({
        where: { categorie_code: { categorie, code } },
        update: {},
        create: { categorie, code, libelle, ordre },
      });
    }
  }
  for (const [ordre, [parent, code, libelle]] of SOUS_TYPES.entries()) {
    const p = await prisma.refValeur.findUniqueOrThrow({
      where: { categorie_code: { categorie: "TYPE_LIEU", code: parent } },
    });
    await prisma.refValeur.upsert({
      where: { categorie_code: { categorie: "SOUS_TYPE_LIEU", code } },
      update: {},
      create: { categorie: "SOUS_TYPE_LIEU", code, libelle, ordre, parentId: p.id },
    });
  }

  for (const [code, libelle] of [["MA_TROMBINE", "Ma Trombine"], ["PRESTIGE", "Prestige (Selfizee)"]]) {
    await prisma.gamme.upsert({ where: { code }, update: {}, create: { code, libelle } });
  }

  const typesModule = [
    { code: "INGENICO_SELF_2000", libelle: "Ingenico Self 2000", fournisseur: "Ingenico", rapprochable: true },
    { code: "MONNAYEUR", libelle: "Monnayeur", fournisseur: null, rapprochable: false },
    { code: "STRIPE_TERMINAL", libelle: "Stripe Terminal", fournisseur: "Stripe", rapprochable: true },
  ];
  for (const t of typesModule) {
    await prisma.typeModulePaiement.upsert({ where: { code: t.code }, update: {}, create: t });
  }
}
