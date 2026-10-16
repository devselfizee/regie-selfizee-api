// Données de démonstration, générables et effaçables depuis l'application (Paramètres, admin).
// Tout ce qui est créé ici est rattaché à des lieux et des bornes marqués `demo` :
// l'effacement ne supprime que ce qui dépend d'eux, et refuse si une vraie borne
// ou un vrai lieu y est mêlé.
import { TZDate } from "@date-fns/tz";
import type { Borne, Prisma, RefCategorie } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import { FUSEAU_METIER, jourEtHeureLocaux } from "../lib/temps.js";
import { ingererLotTransactions } from "../ingestion/transactions.js";
import { ingererHeartbeats } from "../ingestion/heartbeats.js";
import { calculerReversements } from "../commissions/service.js";
import { synchroniserMeteo } from "../calendrier/meteo.js";

const JOUR = 86_400_000;
export const JOURS_DEMO = 90;
export const PREFIXE_DEMO = "[DÉMO] ";

// Générateur pseudo-aléatoire déterministe : mêmes données à chaque génération
function generateur(graine: number) {
  let g = graine;
  const alea = () => ((g = (g * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
  const poisson = (lambda: number) => {
    let k = 0;
    for (let p = Math.exp(-lambda), s = alea(); s > p; s *= alea()) k++;
    return k;
  };
  return { alea, poisson };
}

interface ProfilDemo {
  enseigne: string;
  raisonSociale: string;
  ville: string;
  codePostal: string;
  latitude: number;
  longitude: number;
  type: string;
  zone: string;
  standing: string;
  saisonnier: boolean;
  capacite: number;
  visibilite: number;
  interieur: "INTERIEUR" | "EXTERIEUR";
  /** Ventes moyennes par heure locale, et coefficient par jour de semaine (1 = lundi) */
  heures: Record<number, number>;
  jours: Record<number, number>;
  borne?: { identifiant: string; gamme: string };
  prix: [libelle: string, cents: number, tirages: number][];
  contrat?: Prisma.ContratCommissionCreateWithoutLieuInput;
}

const PROFILS: ProfilDemo[] = [
  {
    enseigne: "Camping Les Dunes", raisonSociale: "SARL Les Dunes", ville: "Saint-Hilaire-de-Riez", codePostal: "85270",
    latitude: 46.7208, longitude: -1.9469, type: "CAMPING", zone: "LITTORAL", standing: "PREMIUM", saisonnier: true,
    capacite: 1200, visibilite: 4, interieur: "EXTERIEUR",
    heures: { 10: 0.4, 11: 0.6, 14: 0.5, 15: 0.8, 16: 1, 17: 1.2, 18: 1.4, 19: 1, 20: 1.3, 21: 1.6, 22: 1.1 },
    jours: { 1: 0.9, 2: 0.9, 3: 1, 4: 1, 5: 1.2, 6: 1.4, 7: 1.2 },
    borne: { identifiant: "DEMO-S01", gamme: "SPHERIK" },
    prix: [["2 tirages", 600, 2], ["4 tirages", 800, 4]],
    contrat: { version: 1, dateEffet: new Date(0), modele: "POURCENTAGE", tauxBp: 2000 },
  },
  {
    enseigne: "Le Phare Club", raisonSociale: "SAS Phare Nuit", ville: "La Baule-Escoublac", codePostal: "44500",
    latitude: 47.2867, longitude: -2.3906, type: "BOITE_DE_NUIT", zone: "URBAINE", standing: "STANDARD", saisonnier: false,
    capacite: 800, visibilite: 5, interieur: "INTERIEUR",
    heures: { 0: 3.2, 1: 3.6, 2: 2.8, 3: 1.6, 4: 0.6, 23: 1.8 },
    jours: { 4: 0.6, 5: 1.6, 6: 2.2 },
    borne: { identifiant: "DEMO-K01", gamme: "KALIFUN" },
    prix: [["2 tirages", 600, 2], ["Duo", 1000, 4]],
    contrat: { version: 1, dateEffet: new Date(0), modele: "POURCENTAGE_APRES_SEUIL", tauxBp: 2500, seuilCents: 50000, seuilMode: "AU_DELA", seuilCumul: "PAR_PERIODE" },
  },
  {
    enseigne: "Bar du Port", raisonSociale: "EURL Bar du Port", ville: "Nantes", codePostal: "44000",
    latitude: 47.2134, longitude: -1.5536, type: "BAR", zone: "URBAINE", standing: "STANDARD", saisonnier: false,
    capacite: 150, visibilite: 3, interieur: "INTERIEUR",
    heures: { 18: 0.3, 19: 0.4, 20: 0.5, 21: 0.6, 22: 0.7, 23: 0.5 },
    jours: { 2: 0.6, 3: 0.8, 4: 1, 5: 1.4, 6: 1.5 },
    borne: { identifiant: "DEMO-C01", gamme: "CLASSIC" },
    prix: [["2 tirages", 500, 2]],
    contrat: { version: 1, dateEffet: new Date(0), modele: "FORFAIT", forfaitCents: 5000, tauxBp: 1000 },
  },
  {
    enseigne: "Centre Océane", raisonSociale: "SCI Océane", ville: "Saint-Herblain", codePostal: "44800",
    latitude: 47.2253, longitude: -1.6247, type: "CENTRE_COMMERCIAL", zone: "PERIURBAINE", standing: "STANDARD", saisonnier: false,
    capacite: 5000, visibilite: 4, interieur: "INTERIEUR",
    heures: { 10: 0.6, 11: 0.8, 12: 0.7, 13: 0.6, 14: 0.9, 15: 1.1, 16: 1.3, 17: 1.2, 18: 1, 19: 0.6 },
    jours: { 1: 0.6, 2: 0.6, 3: 1.2, 4: 0.7, 5: 0.9, 6: 1.8 },
    borne: { identifiant: "DEMO-S02", gamme: "SPHERIK" },
    prix: [["Photo d'identité", 600, 1], ["Pack 3 tirages", 1500, 3]],
    contrat: {
      version: 1, dateEffet: new Date(0), modele: "PALIERS", paliersMode: "MARGINAL",
      paliers: { create: [{ depuisCents: 0, tauxBp: 1000 }, { depuisCents: 100000, tauxBp: 2000 }] },
    },
  },
];

const PROSPECT: ProfilDemo = {
  enseigne: "Bowling Atlantique", raisonSociale: "SAS Bowling Atlantique", ville: "Rezé", codePostal: "44400",
  latitude: 47.1833, longitude: -1.55, type: "BOWLING", zone: "PERIURBAINE", standing: "STANDARD", saisonnier: false,
  capacite: 400, visibilite: 4, interieur: "INTERIEUR", heures: {}, jours: {}, prix: [],
};

export async function etatDemo() {
  const [lieux, bornes] = await Promise.all([
    prisma.lieu.count({ where: { demo: true } }),
    prisma.borne.findMany({ where: { demo: true }, select: { id: true } }),
  ]);
  const ventes = bornes.length ? await prisma.transaction.count({ where: { borneId: { in: bornes.map((b) => b.id) } } }) : 0;
  return { present: lieux + bornes.length > 0, lieux, bornes: bornes.length, ventes };
}

async function ref(categorie: RefCategorie, code: string) {
  const v = await prisma.refValeur.findUnique({ where: { categorie_code: { categorie, code } } });
  if (!v) throw new HttpError(409, "REFERENTIEL_INCOMPLET", `Valeur ${categorie} « ${code} » absente du référentiel`);
  return v.id;
}

/** Minuit (Paris) du jour donné, décalé de `jours`. */
const jourParis = (base: Date, jours: number) => new Date(jourEtHeureLocaux(base).jour.getTime() + jours * JOUR);
const instantParis = (jour: Date, heure: number, minute: number, seconde: number) =>
  new Date(new TZDate(jour.getUTCFullYear(), jour.getUTCMonth(), jour.getUTCDate(), heure, minute, seconde, FUSEAU_METIER).getTime());

async function creerLieu(p: ProfilDemo, debut: Date, prospect = false) {
  const nuit = Object.keys(p.heures).map(Number).some((h) => h < 6);
  const heures = Object.keys(p.heures).map(Number);
  const annee = debut.getUTCFullYear();
  return prisma.lieu.create({
    data: {
      demo: true,
      statut: prospect ? "PROSPECT" : "ACTIF",
      enseigne: PREFIXE_DEMO + p.enseigne,
      raisonSociale: p.raisonSociale,
      ville: p.ville,
      codePostal: p.codePostal,
      latitude: p.latitude,
      longitude: p.longitude,
      typeLieuId: await ref("TYPE_LIEU", p.type),
      zoneGeoId: await ref("ZONE_GEO", p.zone),
      standingId: await ref("STANDING", p.standing),
      saisonnalite: p.saisonnier ? "SAISONNIER" : "ANNUEL",
      capaciteAccueil: p.capacite,
      visibilite: p.visibilite,
      interieurExterieur: p.interieur,
      dateInstallation: prospect ? null : debut,
      notes: "Données de démonstration : à effacer depuis Paramètres avant la mise en service.",
      horaires: prospect
        ? undefined
        : {
            create: Object.keys(p.jours).map((j) => ({
              jourSemaine: Number(j),
              ouverture: new Date(`1970-01-01T${String(nuit ? 23 : Math.min(...heures)).padStart(2, "0")}:00:00Z`),
              fermeture: new Date(`1970-01-01T${String(nuit ? 5 : Math.max(...heures) + 1).padStart(2, "0")}:00:00Z`),
            })),
          },
      saisons: p.saisonnier
        ? { create: [{ libelle: `Saison ${annee}`, debut: new Date(Date.UTC(annee, 3, 1)), fin: new Date(Date.UTC(annee, 8, 30)) }] }
        : undefined,
    },
  });
}

/** Ventes simulées d'un lieu, au format du schéma 1.1, avec tous les cas de l'avenant. */
function ventesSimulees(p: ProfilDemo, borne: string, debut: Date, maintenant: Date, alea: () => number, poisson: (l: number) => number) {
  const ventes: Record<string, unknown>[] = [];
  let n = 0;
  for (let i = 0; i <= JOURS_DEMO; i++) {
    const jour = new Date(debut.getTime() + i * JOUR);
    const finSaison = p.saisonnier && (jour.getUTCMonth() > 8 || jour.getUTCMonth() < 3);
    // Panne de 4 jours sur la borne du bar, il y a une dizaine de jours
    const panne = borne === "DEMO-C01" && i >= JOURS_DEMO - 12 && i < JOURS_DEMO - 8;
    if (finSaison || panne) continue;
    const dow = ((jour.getUTCDay() + 6) % 7) + 1;
    for (const [h, lambda] of Object.entries(p.heures)) {
      const heure = Number(h);
      // Après minuit, c'est la soirée de la veille
      const facteur = p.jours[heure < 6 ? (dow === 1 ? 7 : dow - 1) : dow] ?? 0;
      for (let k = poisson(lambda * facteur); k > 0; k--) {
        const horodatage = instantParis(jour, heure, Math.floor(alea() * 60), Math.floor(alea() * 60));
        if (horodatage > maintenant) continue;
        const [libelle, cents, tirages] = p.prix[Math.floor(alea() * p.prix.length)];
        const id = `${borne}-${horodatage.toISOString().slice(0, 10).replaceAll("-", "")}-${String(++n).padStart(5, "0")}-1`;
        const base = { transaction_id: id, horodatage: horodatage.toISOString(), devise: "EUR", produit: { code: "TIRAGE", libelle, nb_tirages: tirages } };
        const x = alea();
        if (x < 0.1) {
          ventes.push({ ...base, montant_ttc_centimes: cents, statut: "accepte", encaissement: "confirme", module: { type: "STRIPE_QR" }, moyen_paiement: "web", reference_monetique: `pi_demo${n}` });
        } else if (x < 0.14) {
          ventes.push({ ...base, montant_ttc_centimes: cents, statut: "refuse", motif: "banque", module: { type: "HEXAPAY" }, moyen_paiement: "cb", produit: { code: "TIRAGE", nb_tirages: 0 } });
        } else if (x < 0.15) {
          ventes.push({ ...base, montant_ttc_centimes: cents, statut: "expire", motif: "terminal", module: { type: "HEXAPAY" }, moyen_paiement: "autre", produit: { code: "TIRAGE", nb_tirages: 0 } });
        } else if (x < 0.155) {
          ventes.push({ ...base, montant_ttc_centimes: cents, statut: "offert", module: { type: "HEXAPAY" }, moyen_paiement: "sans_contact" });
        } else if (x < 0.165) {
          ventes.push({ ...base, montant_ttc_centimes: 0, statut: "accepte", module: { type: "HEXAPAY" }, moyen_paiement: "aucun", gratuite: "code_staff", produit: { code: "TIRAGE", nb_tirages: 1 } });
        } else {
          const incertain = x > 0.99;
          ventes.push({
            ...base,
            montant_ttc_centimes: cents,
            statut: "accepte",
            encaissement: incertain ? "incertain" : "confirme",
            module: { type: "HEXAPAY" },
            moyen_paiement: alea() < 0.8 ? "sans_contact" : "cb",
            ...(incertain ? {} : { reference_monetique: String(100000 + n).slice(-6) }),
          });
          // « +1 pour un pote » de temps en temps, en boîte de nuit
          if (p.type === "BOITE_DE_NUIT" && alea() < 0.15) {
            ventes.push({
              ...base,
              transaction_id: id.replace(/-1$/, "-2"),
              montant_ttc_centimes: 400,
              statut: "accepte",
              encaissement: "confirme",
              module: { type: "HEXAPAY" },
              moyen_paiement: "sans_contact",
              reference_monetique: String(200000 + n).slice(-6),
              produit: { code: "TIRAGE_EXTRA", libelle: "+1 pour un pote", nb_tirages: 1 },
            });
          }
        }
      }
    }
  }
  return ventes;
}

/** Heartbeats toutes les 5 minutes sur 10 jours, avec des trous qui racontent quelque chose. */
function heartbeatsSimules(borne: string, maintenant: Date) {
  const fin = borne === "DEMO-C01" ? maintenant.getTime() - 6 * 3_600_000 : maintenant.getTime(); // bar : muette depuis 6 h
  const heartbeats = [];
  for (let t = maintenant.getTime() - 10 * JOUR; t <= fin; t += 5 * 60_000) {
    // Coupure réseau de 3 h il y a 2 jours sur la boîte de nuit
    if (borne === "DEMO-K01" && t > maintenant.getTime() - 2 * JOUR && t < maintenant.getTime() - 2 * JOUR + 3 * 3_600_000) continue;
    const restants = Math.round(400 - ((t - (maintenant.getTime() - 10 * JOUR)) / JOUR) * 30);
    heartbeats.push({
      horodatage: new Date(t).toISOString(),
      logiciel_version: "demo-2026.10",
      papier_restant: Math.max(20, restants),
      imprimante_ok: true,
      module_paiement_ok: true,
    });
  }
  return heartbeats;
}

/**
 * Crée 4 lieux équipés (90 jours de ventes, contrats, reversements, événements, SAV), un prospect
 * et une borne en stock. Refuse si des données de démonstration existent déjà.
 */
export async function genererDemo(maintenant = new Date()) {
  if ((await etatDemo()).present) throw new HttpError(409, "DEMO_DEJA_PRESENTE", "Des données de démonstration existent déjà : effacez-les d'abord");
  const deja = await prisma.borne.findMany({ where: { identifiant: { startsWith: "DEMO-" } }, select: { identifiant: true } });
  if (deja.length) throw new HttpError(409, "IDENTIFIANT_PRIS", `Identifiants déjà utilisés par de vraies bornes : ${deja.map((b) => b.identifiant).join(", ")}`);

  const { alea, poisson } = generateur(42);
  const debut = jourParis(maintenant, -JOURS_DEMO);
  const hexapay = await prisma.typeModulePaiement.findUnique({ where: { code: "HEXAPAY" } });
  if (!hexapay) throw new HttpError(409, "REFERENTIEL_INCOMPLET", "Module HEXAPAY absent du référentiel");
  let ventes = 0;
  const lieuxIds: number[] = [];

  for (const p of PROFILS) {
    const lieu = await creerLieu(p, debut);
    lieuxIds.push(lieu.id);
    const gamme = await prisma.gamme.findUnique({ where: { code: p.borne!.gamme } });
    if (!gamme) throw new HttpError(409, "REFERENTIEL_INCOMPLET", `Gamme ${p.borne!.gamme} absente du référentiel`);
    const borne: Borne = await prisma.borne.create({
      data: {
        demo: true,
        identifiant: p.borne!.identifiant,
        gammeId: gamme.id,
        numeroSerie: `SN-${p.borne!.identifiant}`,
        statut: "INSTALLEE",
        coutAchatCents: 450000,
        dureeAmortissementMois: 36,
        dateMiseEnService: debut,
        modules: { create: { typeId: hexapay.id, identifiantPrestataire: `TID-${p.borne!.identifiant}`, installeLe: debut } },
      },
    });
    await prisma.affectationBorne.create({ data: { borneId: borne.id, lieuId: lieu.id, debut } });

    // Ventes, par la vraie ingestion (agrégats, contrôles, idempotence)
    const lot = ventesSimulees(p, borne.identifiant, debut, maintenant, alea, poisson);
    for (let i = 0; i < lot.length; i += 500) {
      const r = await ingererLotTransactions(
        borne,
        { schema_version: "1.1", borne_id: borne.identifiant, envoye_le: maintenant.toISOString(), logiciel_version: "demo-2026.10", transactions: lot.slice(i, i + 500) },
        "demo"
      );
      if (r.rejetees) throw new Error(`Démo ${borne.identifiant} : ${r.erreurs[0]?.message}`);
      ventes += r.creees;
    }
    const hb = heartbeatsSimules(borne.identifiant, maintenant);
    for (let i = 0; i < hb.length; i += 2000)
      await ingererHeartbeats(borne, { schema_version: "1.1", borne_id: borne.identifiant, heartbeats: hb.slice(i, i + 2000) });

    if (p.contrat) await prisma.contratCommission.create({ data: { ...p.contrat, dateEffet: debut, lieu: { connect: { id: lieu.id } } } });
  }

  // Histoire des lieux : SAV, coûts, événements
  const [bar, phare, camping] = await Promise.all(
    ["DEMO-C01", "DEMO-K01", "DEMO-S01"].map((identifiant) => prisma.borne.findUniqueOrThrow({ where: { identifiant } }))
  );
  const intervention = await prisma.intervention.create({
    data: {
      borneId: bar.id, date: jourParis(maintenant, -8), motif: "Imprimante bloquée (bourrage)",
      compteRendu: "Galet d'entraînement remplacé", enPanneDepuis: jourParis(maintenant, -12), resolueLe: jourParis(maintenant, -8),
    },
  });
  await prisma.coutBorne.createMany({
    data: [
      { borneId: bar.id, date: jourParis(maintenant, -8), categorie: "INTERVENTION", montantCents: 6500, libelle: "Déplacement technicien", interventionId: intervention.id },
      { borneId: camping.id, date: jourParis(maintenant, -60), categorie: "CONSOMMABLES", montantCents: 18000, libelle: "Kit papier + ruban" },
      { borneId: phare.id, date: jourParis(maintenant, -30), categorie: "CONSOMMABLES", montantCents: 9000, libelle: "Kit papier + ruban" },
    ],
  });
  const [soiree, travaux] = await Promise.all([ref("TYPE_EVENEMENT", "SOIREE"), ref("TYPE_EVENEMENT", "TRAVAUX")]);
  await prisma.evenementLieu.createMany({
    data: [
      { lieuId: lieuxIds[1], typeId: soiree, libelle: "Soirée années 80", debut: jourParis(maintenant, -26), fin: jourParis(maintenant, -26) },
      { lieuId: lieuxIds[3], typeId: travaux, libelle: "Travaux dans la galerie", debut: jourParis(maintenant, -45), fin: jourParis(maintenant, -38) },
    ],
  });

  // Un prospect et une borne en stock
  await creerLieu(PROSPECT, debut, true);
  await prisma.borne.create({
    data: { demo: true, identifiant: "DEMO-S03", gammeId: (await prisma.gamme.findUniqueOrThrow({ where: { code: "SPHERIK" } })).id, numeroSerie: "SN-DEMO-S03" },
  });

  // Reversements des périodes terminées, puis météo des lieux (réseau : sans bloquer la réponse)
  for (const lieuId of lieuxIds) await calculerReversements({ lieuId });
  if (process.env.DONNEES_EXTERNES !== "0" && !process.env.VITEST)
    void synchroniserMeteo({ lieuIds: lieuxIds }).catch((err) => console.error("Météo démo :", err));

  return { ...(await etatDemo()), ventesCreees: ventes };
}

/**
 * Efface tout ce qui dépend des lieux et bornes de démonstration, en une transaction.
 * Refuse si une vraie borne a été affectée à un lieu de démo, ou une borne de démo à un vrai lieu.
 */
export async function effacerDemo() {
  const [lieux, bornes] = await Promise.all([
    prisma.lieu.findMany({ where: { demo: true }, select: { id: true } }),
    prisma.borne.findMany({ where: { demo: true }, select: { id: true } }),
  ]);
  const L = lieux.map((l) => l.id);
  const B = bornes.map((b) => b.id);
  if (!L.length && !B.length) return { lieux: 0, bornes: 0, ventes: 0 };

  const melanges = await prisma.affectationBorne.findMany({
    where: { OR: [{ lieuId: { in: L }, borneId: { notIn: B } }, { borneId: { in: B }, lieuId: { notIn: L } }] },
    select: { borne: { select: { identifiant: true } }, lieu: { select: { enseigne: true } } },
  });
  if (melanges.length)
    throw new HttpError(
      409,
      "DEMO_MELANGEE",
      `Données de démo mêlées à de vraies données (${melanges.map((m) => `${m.borne.identifiant} → ${m.lieu.enseigne}`).join(", ")}) : rien n'a été effacé. Retirez d'abord ces affectations.`
    );

  const ventes = await prisma.transaction.count({ where: { borneId: { in: B } } });
  await prisma.$transaction(
    async (db) => {
      const tx = { borneId: { in: B } };
      const idsVentes = (await db.transaction.findMany({ where: tx, select: { id: true } })).map((t) => t.id);
      // Lignes de relevés monétiques rapprochées avec des ventes de démo : redeviennent non rapprochées
      await db.releveLigne.updateMany({ where: { transactionId: { in: idsVentes } }, data: { transactionId: null, statut: "NON_RAPPROCHE" } });
      await db.alerte.deleteMany({ where: { OR: [{ lieuId: { in: L } }, { borneId: { in: B } }] } });
      await db.regleAlerte.deleteMany({ where: { lieuId: { in: L } } });
      await db.reversement.deleteMany({ where: { lieuId: { in: L } } });
      await db.contratCommission.deleteMany({ where: { lieuId: { in: L } } });
      await db.aggJour.deleteMany({ where: { OR: [{ borneId: { in: B } }, { lieuId: { in: L } }] } });
      await db.aggHeure.deleteMany({ where: { OR: [{ borneId: { in: B } }, { lieuId: { in: L } }] } });
      await db.aggDisponibilite.deleteMany({ where: { borneId: { in: B } } });
      await db.transaction.deleteMany({ where: { ...tx, transactionOrigineId: { not: null } } });
      await db.transaction.deleteMany({ where: tx });
      await db.importLot.deleteMany({ where: { borneId: { in: B } } });
      await db.heartbeat.deleteMany({ where: { borneId: { in: B } } });
      await db.coutBorne.deleteMany({ where: { borneId: { in: B } } });
      await db.intervention.deleteMany({ where: { borneId: { in: B } } });
      await db.modulePaiement.deleteMany({ where: { borneId: { in: B } } });
      await db.affectationBorne.deleteMany({ where: { OR: [{ borneId: { in: B } }, { lieuId: { in: L } }] } });
      await db.user.updateMany({ where: { lieuId: { in: L } }, data: { lieuId: null } });
      await db.borne.deleteMany({ where: { id: { in: B } } });
      // Contacts, horaires, saisons, fermetures, événements et météo suivent en cascade
      await db.lieu.deleteMany({ where: { id: { in: L } } });
    },
    { timeout: 120_000 }
  );
  return { lieux: L.length, bornes: B.length, ventes };
}
