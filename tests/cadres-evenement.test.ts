import { describe, expect, it } from "vitest";
import { cadreSchema, verifierCadre, type CadreSaisi } from "../src/config-evenement/cadres.js";

// Cadres du studio de la fiche événement : le cadre doit correspondre au gabarit du kit
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const cadre = (p: Partial<CadreSaisi>): CadreSaisi =>
  cadreSchema.parse({ nom: "La Ruche — bandelette", formatId: "marque-page", gabaritStudioId: "mp-4", nbPoses: 4, canvas: "{}", image: PNG, ...p });

describe("cadres de la fiche événement", () => {
  it("accepte une bandelette 4 poses sur le marque-page", () => {
    expect(verifierCadre("bandelette", cadre({}))).toBeNull();
  });

  it("refuse un format qui ne correspond pas au gabarit", () => {
    expect(verifierCadre("bandelette", cadre({ formatId: "polaroid", gabaritStudioId: "pol-1" }))).toMatch(/format/);
    expect(verifierCadre("planche", cadre({ formatId: "polaroid-multishoot", gabaritStudioId: "polm-2", nbPoses: 2 }))).toMatch(/gabarit/);
  });

  it("refuse un nombre de poses différent de celui du kit", () => {
    expect(verifierCadre("bandelette", cadre({ nbPoses: 3 }))).toMatch(/4 poses/);
    expect(verifierCadre("pola", cadre({ formatId: "polaroid", gabaritStudioId: "pol-1", nbPoses: 2 }))).toMatch(/1 pose,/);
  });

  it("laisse le choix entre polaroid et carte postale portrait pour le pola", () => {
    expect(verifierCadre("pola", cadre({ formatId: "polaroid", gabaritStudioId: "pol-1", nbPoses: 1 }))).toBeNull();
    expect(verifierCadre("pola", cadre({ formatId: "carte-postale-portrait", gabaritStudioId: "cpprt-2", nbPoses: 1 }))).toBeNull();
  });

  it("n'accepte que des images en data URL", () => {
    expect(() => cadre({ image: "https://exemple.fr/cadre.png" })).toThrow();
    expect(() => cadre({ vignette: "data:image/gif;base64,R0lG" })).toThrow();
  });
});
