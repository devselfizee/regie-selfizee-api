import { PrismaClient, type RefCategorie } from "@prisma/client";
import { genererCle } from "../src/lib/cleBorne.js";

const prisma = new PrismaClient();

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

async function main() {
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

  // ─── Données de démo (dev uniquement) ───
  if (process.env.NODE_ENV === "production") return;

  const ref = (categorie: RefCategorie, code: string) =>
    prisma.refValeur.findUniqueOrThrow({ where: { categorie_code: { categorie, code } } }).then((r) => r.id);

  const lieu =
    (await prisma.lieu.findFirst({ where: { enseigne: "Camping Les Flots Bleus (démo)" } })) ??
    (await prisma.lieu.create({
      data: {
        raisonSociale: "SARL Flots Bleus",
        enseigne: "Camping Les Flots Bleus (démo)",
        ville: "Saint-Jean-de-Monts",
        codePostal: "85160",
        typeLieuId: await ref("TYPE_LIEU", "CAMPING"),
        sousTypeId: await ref("SOUS_TYPE_LIEU", "CAMPING_4_5"),
        saisonnalite: "SAISONNIER",
        zoneGeoId: await ref("ZONE_GEO", "LITTORAL"),
        capaciteAccueil: 1200,
        interieurExterieur: "EXTERIEUR",
        visibilite: 4,
      },
    }));

  const gamme = await prisma.gamme.findUniqueOrThrow({ where: { code: "MA_TROMBINE" } });
  const existante = await prisma.borne.findUnique({ where: { identifiant: "MT-0042" } });
  if (!existante) {
    const cle = genererCle();
    const borne = await prisma.borne.create({
      data: {
        identifiant: "MT-0042",
        gammeId: gamme.id,
        numeroSerie: "MT2026-0042",
        statut: "INSTALLEE",
        apiKeyHash: cle.hash,
        apiKeyPrefix: cle.prefixe,
        apiKeyCreeLe: new Date(),
      },
    });
    await prisma.affectationBorne.create({
      data: { borneId: borne.id, lieuId: lieu.id, debut: new Date("2026-04-01T00:00:00+02:00") },
    });
    console.log(`Borne de démo MT-0042 créée. Clé API (affichée une seule fois) :\n${cle.cle}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
