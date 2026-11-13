import { describe, expect, it } from "vitest";
import { telephoneE164 } from "../src/lib/telephone.js";

// Téléphones des contacts d'un lieu : toujours enregistrés en E.164, quelle que soit la saisie (retour du 12/11)
describe("telephoneE164", () => {
  it("ramène les saisies françaises et internationales au même format", () => {
    for (const saisie of ["06 69 04 59 35", "06.69.04.59.35", "0669045935", "+33 6 69 04 59 35", "+33669045935", "0033 6 69 04 59 35", "+33 (0)6 69 04 59 35", "+33 06 69 04 59 35", "6 69 04 59 35"]) {
      expect(telephoneE164(saisie), saisie).toBe("+33669045935");
    }
    expect(telephoneE164("+971 50 123 4567")).toBe("+971501234567");
    expect(telephoneE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(telephoneE164("0032 2 555 12 12")).toBe("+3225551212");
  });

  it("vide : null ; impossible : undefined (refusé à l'enregistrement)", () => {
    expect(telephoneE164("")).toBeNull();
    expect(telephoneE164("   ")).toBeNull();
    expect(telephoneE164(null)).toBeNull();
    for (const faux of ["06 69 04", "appeler le soir", "+33 6 69 04 59 35 99", "06+69", "12345"]) expect(telephoneE164(faux), faux).toBeUndefined();
  });
});
