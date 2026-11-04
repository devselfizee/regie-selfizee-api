import { describe, expect, it } from "vitest";
import { identiteKeycloak } from "../src/middleware/utilisateur.js";

describe("identité recopiée de Keycloak", () => {
  it("reprend nom, prénom et téléphone du jeton", () => {
    expect(identiteKeycloak({ sub: "s", family_name: " Rossi ", given_name: "Emma", phone_number: "+33600000000" })).toEqual({
      nom: "Rossi",
      prenom: "Emma",
      telephone: "+33600000000",
    });
  });

  it("ne touche pas aux champs absents ou vides du jeton", () => {
    expect(identiteKeycloak({ sub: "s", family_name: "Rossi", given_name: "  " })).toEqual({ nom: "Rossi" });
    expect(identiteKeycloak(undefined)).toEqual({});
  });
});
