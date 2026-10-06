import { describe, expect, it } from "vitest";
import { calculerPeriode, decrireContrat, partVariable, type RegleContrat, type VentesPeriode } from "../src/commissions/moteur.js";
import { estDebutDePeriode, periodesDuContrat } from "../src/commissions/periodes.js";

const base: RegleContrat = {
  modele: "AUCUNE", base: "TTC", netRemboursements: true, periodicite: "MOIS",
  tauxBp: null, seuilCents: null, seuilMode: null, seuilCumul: null,
  forfaitCents: null, minimumGarantiCents: null, paliersMode: null, paliers: [],
};
const contrat = (r: Partial<RegleContrat>): RegleContrat => ({ ...base, ...r });
const ca = (euros: number, rembourseEuros = 0): VentesPeriode => ({
  caTtcCents: euros * 100,
  caHtCents: Math.round((euros * 100) / 1.2),
  rembourseTtcCents: rembourseEuros * 100,
  rembourseHtCents: Math.round((rembourseEuros * 100) / 1.2),
});
const commission = (r: RegleContrat, euros: number, cumulAvant = 0) => calculerPeriode(r, ca(euros), cumulAvant * 100).commissionCents / 100;

// Les exemples du CDC (§6), un par modèle
describe("modèles du CDC", () => {
  it("aucune commission", () => {
    expect(commission(contrat({ modele: "AUCUNE" }), 1500)).toBe(0);
  });

  it("pourcentage direct : 20 % du CA mensuel", () => {
    expect(commission(contrat({ modele: "POURCENTAGE", tauxBp: 2000 }), 1500)).toBe(300);
  });

  it("pourcentage après seuil : 25 % au-delà de 500 €/mois", () => {
    const r = contrat({ modele: "POURCENTAGE_APRES_SEUIL", tauxBp: 2500, seuilCents: 50000, seuilMode: "AU_DELA" });
    expect(commission(r, 400)).toBe(0);
    expect(commission(r, 800)).toBe(75); // 25 % × 300 €
  });

  it("pourcentage dès que le seuil est atteint (variante à préciser au CDC)", () => {
    const r = contrat({ modele: "POURCENTAGE_APRES_SEUIL", tauxBp: 2500, seuilCents: 50000, seuilMode: "DES_ATTEINTE" });
    expect(commission(r, 499)).toBe(0);
    expect(commission(r, 800)).toBe(200); // 25 % × 800 €
  });

  it("paliers : 10 % jusqu'à 1 000 €, 20 % au-delà", () => {
    const paliers = [{ depuisCents: 0, tauxBp: 1000 }, { depuisCents: 100000, tauxBp: 2000 }];
    expect(commission(contrat({ modele: "PALIERS", paliers, paliersMode: "MARGINAL" }), 1500)).toBe(200); // 100 + 100
    expect(commission(contrat({ modele: "PALIERS", paliers, paliersMode: "GLOBAL" }), 1500)).toBe(300); // 20 % × 1 500
    expect(commission(contrat({ modele: "PALIERS", paliers, paliersMode: "GLOBAL" }), 900)).toBe(90);
  });

  it("forfait : 50 €/mois + 10 %", () => {
    expect(commission(contrat({ modele: "FORFAIT", forfaitCents: 5000, tauxBp: 1000 }), 1500)).toBe(200);
    expect(commission(contrat({ modele: "FORFAIT", forfaitCents: 5000 }), 0)).toBe(50);
  });

  it("minimum garanti : 100 €/mois, combinable avec un pourcentage", () => {
    const r = contrat({ modele: "POURCENTAGE", tauxBp: 2000, minimumGarantiCents: 10000 });
    const faible = calculerPeriode(r, ca(300));
    expect(faible.commissionCents).toBe(10000);
    expect(faible.minimumApplique).toBe(true);
    expect(commission(r, 1500)).toBe(300);
  });
});

describe("base de calcul", () => {
  it("nette des remboursements, ou non", () => {
    const r = contrat({ modele: "POURCENTAGE", tauxBp: 2000 });
    expect(calculerPeriode(r, ca(1000, 100)).baseCalculCents).toBe(90000);
    expect(calculerPeriode({ ...r, netRemboursements: false }, ca(1000, 100)).baseCalculCents).toBe(100000);
  });

  it("sur le HT", () => {
    const r = contrat({ modele: "POURCENTAGE", tauxBp: 2000, base: "HT" });
    expect(calculerPeriode(r, ca(1200)).commissionCents).toBe(20000);
  });

  it("jamais négative (plus de remboursements que de ventes)", () => {
    expect(calculerPeriode(contrat({ modele: "POURCENTAGE", tauxBp: 2000 }), ca(100, 300)).commissionCents).toBe(0);
  });

  it("arrondit au centime", () => {
    expect(calculerPeriode(contrat({ modele: "POURCENTAGE", tauxBp: 1750 }), { ...ca(0), caTtcCents: 333 }).commissionCents).toBe(58);
  });
});

describe("seuil cumulé depuis la date d'effet", () => {
  const r = contrat({ modele: "POURCENTAGE_APRES_SEUIL", tauxBp: 2500, seuilCents: 50000, seuilMode: "AU_DELA", seuilCumul: "CUMULE" });

  it("le seuil n'est franchi qu'une fois, sur plusieurs mois", () => {
    // 300 € puis 400 € puis 300 € : seuil de 500 € franchi au 2e mois
    const m1 = commission(r, 300, 0); // cumul 0 → 300
    const m2 = commission(r, 400, 300); // cumul 300 → 700 : 200 € au-delà
    const m3 = commission(r, 300, 700); // cumul 700 → 1 000
    expect([m1, m2, m3]).toEqual([0, 50, 75]);
    // Total identique au calcul sur le cumul global (25 % × 500 €)
    expect(m1 + m2 + m3).toBe(125);
  });

  it("paliers cumulés : la somme des périodes égale le calcul global", () => {
    const p = contrat({
      modele: "PALIERS", paliersMode: "MARGINAL", seuilCumul: "CUMULE",
      paliers: [{ depuisCents: 0, tauxBp: 1000 }, { depuisCents: 100000, tauxBp: 2000 }],
    });
    const mois = [600, 700, 500];
    let cumul = 0;
    let total = 0;
    for (const m of mois) {
      total += commission(p, m, cumul);
      cumul += m;
    }
    expect(total).toBe(partVariable(p, 180000).montant / 100); // 100 + 160 = 260
    expect(total).toBe(260);
  });

  it("dès atteinte, cumulé : rattrapage sur le CA déjà réalisé quand le seuil est franchi", () => {
    const d = { ...r, seuilMode: "DES_ATTEINTE" as const };
    expect(commission(d, 300, 0)).toBe(0);
    expect(commission(d, 400, 300)).toBe(175); // 25 % × 700 € d'un coup
    expect(commission(d, 300, 700)).toBe(75);
  });
});

describe("périodes", () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const ymd = (p: { debut: Date; fin: Date }) => `${p.debut.toISOString().slice(0, 10)}→${p.fin.toISOString().slice(0, 10)}`;

  it("mois, trimestres et années civils", () => {
    expect(periodesDuContrat({ periodicite: "MOIS", dateEffet: d("2026-01-01"), dateFin: null }, d("2026-03-31")).map(ymd)).toEqual([
      "2026-01-01→2026-01-31", "2026-02-01→2026-02-28", "2026-03-01→2026-03-31",
    ]);
    expect(periodesDuContrat({ periodicite: "TRIMESTRE", dateEffet: d("2026-04-01"), dateFin: null }, d("2026-12-31")).map(ymd)).toEqual([
      "2026-04-01→2026-06-30", "2026-07-01→2026-09-30", "2026-10-01→2026-12-31",
    ]);
  });

  it("s'arrête à la veille de l'avenant suivant", () => {
    const p = periodesDuContrat({ periodicite: "MOIS", dateEffet: d("2026-01-01"), dateFin: d("2026-03-01") }, d("2026-12-31"));
    expect(p.map(ymd)).toEqual(["2026-01-01→2026-01-31", "2026-02-01→2026-02-28"]);
  });

  it("saisons du lieu", () => {
    const saisons = [{ debut: d("2026-04-01"), fin: d("2026-09-30") }, { debut: d("2025-04-01"), fin: d("2025-09-30") }];
    const p = periodesDuContrat({ periodicite: "SAISON", dateEffet: d("2026-01-01"), dateFin: null }, d("2026-12-31"), saisons);
    expect(p.map(ymd)).toEqual(["2026-04-01→2026-09-30"]);
  });

  it("une date d'effet doit ouvrir une période", () => {
    expect(estDebutDePeriode(d("2026-03-01"), "MOIS")).toBe(true);
    expect(estDebutDePeriode(d("2026-03-15"), "MOIS")).toBe(false);
    expect(estDebutDePeriode(d("2026-02-01"), "TRIMESTRE")).toBe(false);
    expect(estDebutDePeriode(d("2026-07-01"), "TRIMESTRE")).toBe(true);
  });
});

describe("description", () => {
  it("décrit le contrat en clair pour le relevé", () => {
    expect(decrireContrat(contrat({ modele: "POURCENTAGE_APRES_SEUIL", tauxBp: 2500, seuilCents: 50000, seuilMode: "AU_DELA" })))
      .toBe("25 % du CA TTC net des remboursements au-delà de 500,00 €, par mois");
    expect(decrireContrat(contrat({ modele: "FORFAIT", forfaitCents: 5000, tauxBp: 1000, minimumGarantiCents: 10000 })))
      .toBe("Forfait de 50,00 € par mois + 10 % du CA TTC net des remboursements — minimum garanti 100,00 € par mois");
  });
});
