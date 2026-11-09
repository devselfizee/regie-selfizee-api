import { describe, expect, it } from "vitest";
import { identiteKeycloak, idPlateforme, telephoneHub, urlPhotoKonitys } from "../src/middleware/utilisateur.js";
import { corpsNotification, idHub } from "../src/lib/notificationsPlateforme.js";

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

describe("notifications de la plateforme", () => {
  it("lit l'identifiant plateforme de /api/users/me", () => {
    expect(idPlateforme({ data: { id: 141 } })).toBe(141);
    expect(idPlateforme({ data: { data: { id: "12" } } })).toBe(12);
    expect(idPlateforme({ data: {} })).toBeNull();
  });

  it("tire l'ID Hub du sub Keycloak d'un compte fédéré", () => {
    expect(idHub("f:3c1e2a:141")).toBe(141);
    expect(idHub("6f1c2d3e-uuid-non-federe")).toBeNull();
    expect(idHub(null)).toBeNull();
  });

  it("construit le corps attendu par POST /api/notifications", () => {
    expect(corpsNotification({ destinataire: 141, titre: "Seb vous a mentionné", cle: "mention-1-2", entityId: "7", url: "https://x/lieux/7" }, "regie")).toEqual({
      titre: "Seb vous a mentionné",
      contenu: "",
      cle: "mention-1-2",
      origine: "regie",
      entity_id: "7",
      url: "https://x/lieux/7",
      recipient_type: "user",
      recipient_user_id: 141,
    });
  });
});


describe("téléphone de la fiche Hub", () => {
  it("lit le téléphone sous ses noms courants, quelle que soit l'enveloppe", () => {
    expect(telephoneHub({ data: { telephone: "06 12 34 56 78" } })).toBe("06 12 34 56 78");
    expect(telephoneHub({ data: { data: { mobile: "+33612345678" } } })).toBe("+33612345678");
    expect(telephoneHub({ phone: "0612345678" })).toBe("0612345678");
  });

  it("rend null sans numéro exploitable", () => {
    expect(telephoneHub({ data: { telephone: "" } })).toBeNull();
    expect(telephoneHub({ data: { telephone: "n/a" } })).toBeNull();
    expect(telephoneHub(null)).toBeNull();
  });
});
