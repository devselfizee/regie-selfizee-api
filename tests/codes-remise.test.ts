import { describe, expect, it } from "vitest";
import type { CodeRemise, LotCodesRemise } from "@prisma/client";
import { ALPHABET, etatCode, genererCode, normaliserCode } from "../src/codes/codes.js";

// Codes de remise (demande de Sébastien, 02/11/2026)
const lot = (l: Partial<LotCodesRemise> = {}): LotCodesRemise => ({
  id: 1,
  libelle: null,
  type: "OFFERT",
  quantite: 4,
  pourcentage: null,
  lieuId: 10,
  seulementLieu: false,
  expireLe: new Date("2027-11-03T00:00:00Z"),
  nbCodes: 50,
  creeParId: null,
  createdAt: new Date("2026-11-03T09:00:00Z"),
  ...l,
});
const code = (c: Partial<CodeRemise> = {}, l: Partial<LotCodesRemise> = {}) => ({ id: 1, code: "AB3CD", lotId: 1, utilise: 0, desactiveLe: null, ...c, lot: lot(l) });
const maintenant = new Date("2026-11-03T20:00:00Z");

describe("codes de remise", () => {
  it("génère 5 caractères sans les ambigus (0/O, 1/I/L)", () => {
    for (let i = 0; i < 200; i++) expect(genererCode()).toMatch(/^[A-HJKMNP-Z2-9]{5}$/);
    expect(ALPHABET).not.toMatch(/[01ILO]/);
  });

  it("lit un code tapé en minuscules ou avec un espace", () => {
    expect(normaliserCode("ab3 cd")).toBe("AB3CD");
  });

  it("donne ce qu'il reste sur un code entamé", () => {
    expect(etatCode(code({ utilise: 3 }), 10, maintenant)).toEqual({ valide: true, restant: 1 });
  });

  it("refuse un code inconnu, désactivé, épuisé", () => {
    expect(etatCode(null, 10, maintenant)).toEqual({ valide: false, raison: "INCONNU" });
    expect(etatCode(code({ desactiveLe: maintenant }), 10, maintenant)).toEqual({ valide: false, raison: "DESACTIVE" });
    expect(etatCode(code({ utilise: 4 }), 10, maintenant)).toEqual({ valide: false, raison: "EPUISE" });
  });

  it("vaut jusqu'au jour d'expiration inclus, heure de Paris", () => {
    const l = { expireLe: new Date("2026-11-03T00:00:00Z") };
    expect(etatCode(code({}, l), 10, new Date("2026-11-03T22:30:00Z")).valide).toBe(true); // 23 h 30 à Paris
    expect(etatCode(code({}, l), 10, new Date("2026-11-03T23:30:00Z"))).toEqual({ valide: false, raison: "EXPIRE" }); // 0 h 30 le 4
  });

  it("un code réservé à un lieu est refusé ailleurs, un code pour toutes les bornes passe partout", () => {
    expect(etatCode(code({}, { seulementLieu: true }), 12, maintenant)).toEqual({ valide: false, raison: "AUTRE_LIEU" });
    expect(etatCode(code({}, { seulementLieu: true }), null, maintenant)).toEqual({ valide: false, raison: "AUTRE_LIEU" });
    expect(etatCode(code({}, { seulementLieu: true }), 10, maintenant).valide).toBe(true);
    expect(etatCode(code({}, { seulementLieu: false }), 12, maintenant).valide).toBe(true);
  });
});
