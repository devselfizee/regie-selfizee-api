// Données de démonstration (dev uniquement) : lieux, bornes, affectations, puis
// ~90 jours de ventes et de heartbeats envoyés par la vraie API d'ingestion.
// Usage : API démarrée (npm run dev), puis npm run demo
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { genererCle } from "../src/lib/cleBorne.js";

if (process.env.NODE_ENV === "production") throw new Error("Interdit en production");
const API = `http://localhost:${process.env.PORT ?? 3003}`;

// Générateur pseudo-aléatoire déterministe (mêmes données à chaque lancement)
let graine = 42;
const alea = () => ((graine = (graine * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const poisson = (lambda: number) => {
  let k = 0;
  for (let p = Math.exp(-lambda), s = alea(); s > p; s *= alea()) k++;
  return k;
};

type Profil = {
  enseigne: string; raisonSociale: string; ville: string; type: string; zone: string; standing: string;
  saisonnier: boolean; capacite: number; interieur: "INTERIEUR" | "EXTERIEUR";
  // ventes moyennes par heure (heure locale) et par jour de semaine (1 = lundi)
  heures: Record<number, number>; jours: Record<number, number>;
  borne: string; gamme: string; prix: [code: string, libelle: string, cents: number, tirages: number][];
};

const PROFILS: Profil[] = [
  {
    enseigne: "Camping Les Flots Bleus", raisonSociale: "SARL Flots Bleus", ville: "Saint-Jean-de-Monts",
    type: "CAMPING", zone: "LITTORAL", standing: "PREMIUM", saisonnier: true, capacite: 1200, interieur: "EXTERIEUR",
    heures: { 10: 0.4, 11: 0.6, 14: 0.5, 15: 0.8, 16: 1, 17: 1.2, 18: 1.4, 19: 1, 20: 1.3, 21: 1.6, 22: 1.1, 23: 0.4 },
    jours: { 1: 0.9, 2: 0.9, 3: 1, 4: 1, 5: 1.2, 6: 1.4, 7: 1.2 },
    borne: "MT-0101", gamme: "MA_TROMBINE",
    prix: [["BANDE_4", "Bande 4 photos", 600, 2], ["PHOTO_10x15", "Photo 10x15", 800, 1]],
  },
  {
    enseigne: "Le Phare Club", raisonSociale: "SAS Phare Nuit", ville: "La Baule",
    type: "BOITE_DE_NUIT", zone: "URBAINE", standing: "STANDARD", saisonnier: false, capacite: 800, interieur: "INTERIEUR",
    heures: { 0: 3.2, 1: 3.6, 2: 2.8, 3: 1.6, 4: 0.6, 23: 1.8 },
    jours: { 4: 0.6, 5: 1.6, 6: 2.2 },
    borne: "MT-0102", gamme: "MA_TROMBINE",
    prix: [["BANDE_4", "Bande 4 photos", 600, 2], ["DUO", "Duo 2 bandes", 1000, 4]],
  },
  {
    enseigne: "Bar Le Comptoir", raisonSociale: "EURL Comptoir", ville: "Nantes",
    type: "BAR", zone: "URBAINE", standing: "STANDARD", saisonnier: false, capacite: 150, interieur: "INTERIEUR",
    heures: { 18: 0.3, 19: 0.4, 20: 0.5, 21: 0.6, 22: 0.7, 23: 0.5, 0: 0.3 },
    jours: { 2: 0.6, 3: 0.8, 4: 1, 5: 1.4, 6: 1.5 },
    borne: "MT-0103", gamme: "MA_TROMBINE",
    prix: [["BANDE_4", "Bande 4 photos", 500, 2]],
  },
  {
    enseigne: "Centre Atlantis", raisonSociale: "SCI Atlantis", ville: "Saint-Herblain",
    type: "CENTRE_COMMERCIAL", zone: "PERIURBAINE", standing: "STANDARD", saisonnier: false, capacite: 5000, interieur: "INTERIEUR",
    heures: { 10: 0.6, 11: 0.8, 12: 0.7, 13: 0.6, 14: 0.9, 15: 1.1, 16: 1.3, 17: 1.2, 18: 1, 19: 0.6 },
    jours: { 1: 0.6, 2: 0.6, 3: 1.2, 4: 0.7, 5: 0.9, 6: 1.8 },
    borne: "PR-0201", gamme: "PRESTIGE",
    prix: [["PHOTO_ID", "Photo d'identité", 600, 1], ["PRESTIGE_PACK", "Pack Prestige", 1500, 3]],
  },
];

const ref = async (categorie: "TYPE_LIEU" | "ZONE_GEO" | "STANDING", code: string) =>
  (await prisma.refValeur.findUniqueOrThrow({ where: { categorie_code: { categorie, code } } })).id;

const JOURS = 90;
const aujourdhui = new Date();
const debutDemo = new Date(aujourdhui.getTime() - JOURS * 86_400_000);
const ingenico = await prisma.typeModulePaiement.findUniqueOrThrow({ where: { code: "INGENICO_SELF_2000" } });

/** Instant UTC pour une date + heure locale Paris (décalage été/hiver approximé par le mois). */
function instantParis(jour: Date, heure: number, minute: number): string {
  const m = jour.getUTCMonth();
  const offset = m >= 3 && m <= 9 ? 2 : 1;
  const d = new Date(Date.UTC(jour.getUTCFullYear(), jour.getUTCMonth(), jour.getUTCDate(), heure - offset, minute, Math.floor(alea() * 60)));
  return d.toISOString();
}

for (const p of PROFILS) {
  const gamme = await prisma.gamme.findUniqueOrThrow({ where: { code: p.gamme } });
  const lieu =
    (await prisma.lieu.findFirst({ where: { enseigne: p.enseigne } })) ??
    (await prisma.lieu.create({
      data: {
        enseigne: p.enseigne, raisonSociale: p.raisonSociale, ville: p.ville,
        typeLieuId: await ref("TYPE_LIEU", p.type), zoneGeoId: await ref("ZONE_GEO", p.zone), standingId: await ref("STANDING", p.standing),
        saisonnalite: p.saisonnier ? "SAISONNIER" : "ANNUEL", capaciteAccueil: p.capacite, interieurExterieur: p.interieur,
        visibilite: 3 + Math.floor(alea() * 3),
        horaires: {
          create: Object.keys(p.jours).map((j) => {
            const heures = Object.keys(p.heures).map(Number);
            const nuit = heures.some((h) => h < 6);
            return {
              jourSemaine: Number(j),
              ouverture: new Date(`1970-01-01T${String(nuit ? 23 : Math.min(...heures)).padStart(2, "0")}:00:00Z`),
              fermeture: new Date(`1970-01-01T${String(nuit ? 5 : Math.max(...heures) + 1).padStart(2, "0")}:00:00Z`),
            };
          }),
        },
      },
    }));

  if (await prisma.borne.findUnique({ where: { identifiant: p.borne } })) {
    console.log(`${p.borne} existe déjà : ignorée (supprimez-la pour régénérer)`);
    continue;
  }
  const cle = genererCle();
  const borne = await prisma.borne.create({
    data: {
      identifiant: p.borne, gammeId: gamme.id, numeroSerie: `SN-${p.borne}`, statut: "INSTALLEE",
      apiKeyHash: cle.hash, apiKeyPrefix: cle.prefixe, apiKeyCreeLe: new Date(),
      modules: { create: { typeId: ingenico.id, numeroSerie: `TPE-${p.borne}` } },
    },
  });
  await prisma.affectationBorne.create({ data: { borneId: borne.id, lieuId: lieu.id, debut: debutDemo } });

  // Ventes jour par jour (le camping ferme à la mi-septembre, une panne de 4 jours au bar)
  const transactions: object[] = [];
  let n = 0;
  for (let i = 0; i <= JOURS; i++) {
    const jour = new Date(debutDemo.getTime() + i * 86_400_000);
    const finSaison = p.saisonnier && (jour.getUTCMonth() > 8 || (jour.getUTCMonth() === 8 && jour.getUTCDate() > 15));
    const panne = p.borne === "MT-0103" && i >= JOURS - 10 && i < JOURS - 6;
    if (finSaison || panne) continue;
    const dow = ((jour.getUTCDay() + 6) % 7) + 1;
    for (const [h, lambda] of Object.entries(p.heures)) {
      const heure = Number(h);
      // après minuit, c'est la nuit du jour précédent : on décale le jour de semaine
      const facteur = p.jours[heure < 6 ? (dow === 1 ? 7 : dow - 1) : dow] ?? 0;
      for (let k = poisson(lambda * facteur); k > 0; k--) {
        const [code, libelle, cents, tirages] = p.prix[Math.floor(alea() * p.prix.length)];
        const refus = alea() < 0.04;
        const moyen = alea() < 0.75 ? "sans_contact" : alea() < 0.8 ? "cb" : "mobile";
        const horodatage = instantParis(jour, heure, Math.floor(alea() * 60));
        if (new Date(horodatage) > aujourdhui) continue;
        transactions.push({
          transaction_id: `${p.borne}-${++n}`,
          horodatage,
          montant_ttc_centimes: cents,
          devise: "EUR",
          statut: refus ? "refuse" : "accepte",
          module: { type: "INGENICO_SELF_2000", numero_serie: `TPE-${p.borne}` },
          moyen_paiement: moyen,
          ...(refus ? {} : { reference_monetique: `AUT-${n}` }),
          produit: { code, libelle, nb_tirages: refus ? 0 : tirages },
        });
      }
    }
  }

  for (let i = 0; i < transactions.length; i += 500) {
    const res = await fetch(`${API}/ingest/v1/transactions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cle.cle}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0", borne_id: p.borne, envoye_le: new Date().toISOString(), logiciel_version: "3.4.1",
        transactions: transactions.slice(i, i + 500),
      }),
    });
    if (!res.ok) throw new Error(`${p.borne} : ${res.status} ${await res.text()}`);
  }

  // Heartbeats des 2 dernières heures (sauf le bar : borne muette depuis 6 h)
  const fin = p.borne === "MT-0103" ? aujourdhui.getTime() - 6 * 3_600_000 : aujourdhui.getTime();
  const heartbeats = Array.from({ length: 24 }, (_, i) => ({
    horodatage: new Date(fin - (23 - i) * 5 * 60_000).toISOString(),
    logiciel_version: "3.4.1",
    papier_restant: 300 - i,
    ruban_restant: 310 - i,
    imprimante_ok: true,
    module_paiement_ok: true,
  }));
  await fetch(`${API}/ingest/v1/heartbeats`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cle.cle}`, "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: "1.0", borne_id: p.borne, heartbeats }),
  });

  console.log(`${p.enseigne} : ${transactions.length} transactions envoyées par ${p.borne}`);
}

// Une borne en stock, non affectée
await prisma.borne.upsert({
  where: { identifiant: "MT-0199" },
  update: {},
  create: {
    identifiant: "MT-0199",
    gammeId: (await prisma.gamme.findUniqueOrThrow({ where: { code: "MA_TROMBINE" } })).id,
    numeroSerie: "SN-MT-0199",
  },
});

await prisma.$disconnect();
