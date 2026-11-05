import { describe, expect, it } from "vitest";
import { identiteKeycloak, urlPhotoKonitys } from "../src/middleware/utilisateur.js";

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

describe("photo du compte Konitys", () => {
  it("construit l'URL de la photo d'après photo_nom, quelle que soit l'enveloppe de la réponse", () => {
    const base = "https://plateform.test";
    expect(urlPhotoKonitys({ data: { photo_nom: "seb.jpg" } }, base)).toBe("https://plateform.test/uploads/contacts/seb.jpg");
    expect(urlPhotoKonitys({ data: { data: { photo_nom: "a b.png" } } }, base)).toBe("https://plateform.test/uploads/contacts/a%20b.png");
    expect(urlPhotoKonitys({ photo_nom: "x.webp" }, base)).toBe("https://plateform.test/uploads/contacts/x.webp");
  });

  it("rend null sans photo", () => {
    expect(urlPhotoKonitys({ data: { photo_nom: null } })).toBeNull();
    expect(urlPhotoKonitys({ data: { photo_nom: "  " } })).toBeNull();
    expect(urlPhotoKonitys(null)).toBeNull();
  });
});
