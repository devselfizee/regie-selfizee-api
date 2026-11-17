import { describe, expect, it } from "vitest";
import { commissionDuMois, joursCommissionnes, moisDeLaRegle, tableauApport, type RegleApport, type VentesMois } from "../src/apporteurs/calcul.js";

const j = (s: string) => new Date(`${s}T00:00:00Z`);
const regle = (extra: Partial<RegleApport> = {}): RegleApport => ({ tauxBp: 500, base: "TTC", netRemboursements: true, dateDebut: j("2026-09-15"), dateFin: null, ...extra });
const ventes = (caTtc: number, remb = 0, nb = 1): VentesMois => ({ caTtcCents: caTtc, caHtCents: Math.round(caTtc / 1.2), rembourseTtcCents: remb, rembourseHtCents: Math.round(remb / 1.2), nbVentes: nb });

describe("apporteurs d'affaires : commission mensuelle", () => {
  it("applique le taux à la base TTC nette des remboursements, ou HT, ou brute", () => {
    expect(commissionDuMois(regle(), ventes(100_000, 10_000))).toEqual({ baseCents: 90_000, commissionCents: 4_500 });
    expect(commissionDuMois(regle({ netRemboursements: false }), ventes(100_000, 10_000)).commissionCents).toBe(5_000);
    expect(commissionDuMois(regle({ base: "HT", tauxBp: 1000 }), ventes(120_000)).commissionCents).toBe(10_000);
    expect(commissionDuMois(regle(), ventes(0)).commissionCents).toBe(0);
  });

  it("liste les mois du contrat, le plus récent d'abord, jusqu'au mois courant ou à la fin du contrat", () => {
    expect(moisDeLaRegle(regle(), j("2026-11-17")).map((m) => m.toISOString().slice(0, 7))).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(moisDeLaRegle(regle({ dateFin: j("2026-10-10") }), j("2026-11-17")).map((m) => m.toISOString().slice(0, 7))).toEqual(["2026-10", "2026-09"]);
    expect(moisDeLaRegle(regle({ dateDebut: j("2026-12-01") }), j("2026-11-17"))).toEqual([]);
  });

  it("borne les jours commissionnés au contrat et à aujourd'hui", () => {
    const r = regle({ dateFin: j("2026-11-10") });
    expect(joursCommissionnes(r, j("2026-09-01"), j("2026-11-17"))).toEqual({ du: j("2026-09-15"), au: j("2026-09-30") });
    expect(joursCommissionnes(r, j("2026-10-01"), j("2026-11-17"))).toEqual({ du: j("2026-10-01"), au: j("2026-10-31") });
    expect(joursCommissionnes(r, j("2026-11-01"), j("2026-11-17"))).toEqual({ du: j("2026-11-01"), au: j("2026-11-10") });
    expect(joursCommissionnes(regle(), j("2026-11-01"), j("2026-11-17"))).toEqual({ du: j("2026-11-01"), au: j("2026-11-17") });
    expect(joursCommissionnes(r, j("2026-12-01"), j("2026-12-17"))).toBeNull();
  });

  it("construit le tableau mensuel : un mois par ligne, ses lieux, totaux et mois en cours", () => {
    const regles = [
      { ...regle(), lieuId: 1, enseigne: "Camping", ville: "Erquy" },
      { ...regle({ tauxBp: 1000, dateDebut: j("2026-10-01") }), lieuId: 2, enseigne: "Bar", ville: null },
    ];
    const v = new Map<string, VentesMois>([
      ["1:2026-09", ventes(50_000)],
      ["1:2026-10", ventes(100_000, 0, 4)],
      ["2:2026-10", ventes(80_000)],
      ["1:2026-11", ventes(20_000)],
    ]);
    const t = tableauApport(regles, v, j("2026-11-17"));
    expect(t.mois.map((m) => m.mois)).toEqual(["2026-11", "2026-10", "2026-09"]);
    const oct = t.mois[1];
    expect(oct.lieux.map((l) => [l.enseigne, l.commissionCents])).toEqual([["Bar", 8_000], ["Camping", 5_000]]);
    expect(oct.commissionCents).toBe(13_000);
    expect(oct.nbVentes).toBe(5);
    expect(oct.enCours).toBe(false);
    // Septembre : contrat commencé le 15 → jours précisés ; le bar n'y est pas encore
    expect(t.mois[2].lieux).toHaveLength(1);
    expect(t.mois[2].lieux[0]).toMatchObject({ du: "2026-09-15", au: "2026-09-30", commissionCents: 2_500 });
    // Novembre en cours : pas de dates (mois entier jusqu'à aujourd'hui), lieu sans vente listé à zéro
    expect(t.mois[0].enCours).toBe(true);
    expect(t.mois[0].lieux.find((l) => l.enseigne === "Bar")).toMatchObject({ commissionCents: 0, nbVentes: 0 });
    expect(t.mois[0].lieux.find((l) => l.enseigne === "Camping")?.du).toBeUndefined();
    // Contrat terminé en cours de mois : les jours sont précisés même pour le mois en cours
    const fini = tableauApport([{ ...regle({ dateFin: j("2026-11-10") }), lieuId: 1, enseigne: "Camping", ville: null }], v, j("2026-11-17"));
    expect(fini.mois[0].lieux[0]).toMatchObject({ du: "2026-11-01", au: "2026-11-10" });
    expect(t.totaux).toEqual({ moisPrecedentCents: 13_000, anneeCents: 16_500, baseAnneeCents: 250_000, totalCents: 16_500, nbLieux: 2 });
  });
});
