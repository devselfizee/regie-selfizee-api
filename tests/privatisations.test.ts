import { describe, expect, it } from "vitest";
import { montantsPrivatisation, privatisationsComptees } from "../src/stats/privatisations.js";
import type { Filtres } from "../src/stats/filtres.js";

describe("privatisations", () => {
  it("TTC calculé depuis le HT et le taux de TVA (points de base)", () => {
    expect(montantsPrivatisation(14_167, 2000, false)).toEqual({ montantHtCents: 14_167, montantTtcCents: 17_000 });
    expect(montantsPrivatisation(10_000, 550, false)).toEqual({ montantHtCents: 10_000, montantTtcCents: 10_550 });
    expect(montantsPrivatisation(10_000, 0, false)).toEqual({ montantHtCents: 10_000, montantTtcCents: 10_000 });
  });

  it("offerte : 0 €, quel que soit le montant saisi", () => {
    expect(montantsPrivatisation(14_167, 2000, true)).toEqual({ montantHtCents: 0, montantTtcCents: 0 });
  });

  it("hors chiffres avec un filtre de borne, de module ou de moyen de paiement", () => {
    const f: Filtres = { du: new Date("2026-11-01"), au: new Date("2026-11-30") };
    expect(privatisationsComptees(f)).toBe(true);
    expect(privatisationsComptees({ ...f, lieuId: [3] })).toBe(true);
    expect(privatisationsComptees({ ...f, gammeId: [1] })).toBe(false);
    expect(privatisationsComptees({ ...f, typeModuleId: [1] })).toBe(false);
    expect(privatisationsComptees({ ...f, moyenPaiement: ["CB"] })).toBe(false);
  });
});
