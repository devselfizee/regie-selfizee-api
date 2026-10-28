import { describe, expect, it } from "vitest";
import { controler, genererCodeEvenement, reglagesParDefaut, reglagesSchema, type Reglages } from "../src/config-evenement/reglages.js";
import { genererConfig } from "../src/config-evenement/generation.js";

// userSettings de l'export étalon FJT5 (La Ruche, 19/10/2026), sauf allowPromoCode (vrai en régie, CDC § 13.3)
const ETALON_FJT5 = {
  enableBlackAndWhiteFilter: false, enableColorFilter: true, enableCustomFilter: false, enableForm: false, enableGreenScreen: false,
  allowMultiPrinting: true, allowPrinting: true, enableSepiaFilter: false, firstShootCountDown: 3, multiPrintingLimit: 20, mirrorView: true,
  enableRemoveBG: false, removeBgToken: "", showRemainingSheets: true, otherShootsCountDown: 2, watchdogNotificationDelay: 10,
  watchdogTimeoutDelay: 80, printerAutoDetect: true, shutterSound: true, greenScreenAutoSet: true, enablePrintTpeCb: false, printPrice: 3.5,
  payMode: "hexapay", hexaDir: "C:/Hexapay/", allowPromoCode: true,
  uiKit: "nightlife", phrasesTone: "club", singleShootCountDown: 4, reprintEnabled: true, welcomeShowPrice: false,
  welcomeFormats: ["strip_preview", "polaroid_preview"], enablePayment: true, illustrationSet: "festif", assistanceOwner: "selfizee",
};

const laRuche = (): Reglages => {
  const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
  r.gabarits.choisis = [{ id: "bandelette", gabarit: "bandelette" }, { id: "pola", gabarit: "pola" }, { id: "planche", gabarit: "planche" }, { id: "carte", gabarit: "carte" }];
  r.lieu.avisGoogleUrl = "https://g.page/r/exemple/review";
  return r;
};
const horaires = [{ jourSemaine: 5, ouverture: "22:00", fermeture: "05:00" }];
const generer = (r: Reglages) => genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires, maintenant: new Date("2026-10-23T12:00:00Z") });

describe("config.json d'un événement régie", () => {
  it("reproduit les réglages de l'export étalon FJT5", () => {
    const c = generer(laRuche());
    expect(c.userSettings).toMatchObject(ETALON_FJT5);
    expect(c.userSettings.pricing).toMatchObject({
      enabled: true, method: "progressive", highlight: 2, hightlightlabel: "Le plus populaire",
      tiers: [{ from: 1, unitPrice: 3.5 }, { from: 2, unitPrice: 3 }, { from: 3, unitPrice: 2.5 }],
    });
    expect(c.event).toMatchObject({ code: "RA7K", name: "LA RUCHE", startDate: "2026-10-06", endDate: "2028-10-06", allowRetry: true, updateDate: "2026-10-23 14:00:00" });
    expect(c.compositions.map((x) => x.preview)).toEqual(["Frames/strip_preview.jpg", "Frames/polaroid_preview.jpg", "Frames/multiShoot_preview.jpg", "Frames/carte_preview.jpg"]);
    expect(c.pages.length).toBe(6);
    expect(c.languages.length).toBe(2);
  });

  it("ajoute les réglages régie, web et jeu", () => {
    const c = generer(laRuche());
    expect(c.userSettings).toMatchObject({ sendOriginals: false, countdownSound: false, upsellExtraPrintPrice: 2, webReprint: false, postalDelivery: false });
    expect(c.userSettings.openingHours).toEqual([{ day: 5, open: "22:00", close: "05:00" }]);
    expect(c.web).toEqual({ venueName: "La Ruche", city: "Trégueux", googleReviewUrl: "https://g.page/r/exemple/review", instagram: null, tiktok: null, hashtag: "@selfizee" });
    expect(c.game.prizes).toEqual([{ kind: "free", weight: 5 }, { kind: "pct50", weight: 10 }, { kind: "pct30", weight: 35 }, { kind: "none", weight: 50 }]);
  });

  it("suit l'ordre des gabarits choisis et les formats mis en avant", () => {
    const r = laRuche();
    r.gabarits = { choisis: [{ id: "carte", gabarit: "carte" }, { id: "pola", gabarit: "pola" }], accueil: ["carte"] };
    const c = generer(r);
    expect(c.compositions.map((x) => x.preview)).toEqual(["Frames/carte_preview.jpg", "Frames/polaroid_preview.jpg"]);
    expect(c.userSettings.welcomeFormats).toEqual(["carte_preview"]);
  });

  it("un prix unique désactive la grille dégressive", () => {
    const r = laRuche();
    r.tarifs.paliers = [{ de: 1, prixCents: 400 }];
    r.tarifs.palierMisEnAvant = null;
    const c = generer(r);
    expect(c.userSettings.printPrice).toBe(4);
    expect(c.userSettings.pricing).toEqual({ enabled: false, method: "progressive", tiers: [{ from: 1, unitPrice: 4 }] });
  });
});

describe("contrôles avant publication", () => {
  const erreurs = (r: Reglages) => controler(r, true).filter((c) => c.niveau === "erreur").map((c) => c.message);

  it("les réglages par défaut passent, avec l'avertissement sur le lien d'avis", () => {
    const r = reglagesParDefaut({ enseigne: "Le Bar", ville: null, dateInstallation: null });
    expect(erreurs(r)).toEqual([]);
    expect(controler(r, false).map((c) => c.message).join(" ")).toMatch(/avis Google.*horaires/);
  });

  it("bloque une grille qui n'est pas dégressive, un jeu sans codes promo, aucun gabarit", () => {
    const r = laRuche();
    r.tarifs.paliers = [{ de: 1, prixCents: 300 }, { de: 2, prixCents: 350 }];
    r.tarifs.codesPromo = false;
    r.gabarits = { choisis: [], accueil: [] };
    const e = erreurs(r).join(" ");
    expect(e).toMatch(/dégressive/);
    expect(e).toMatch(/codes promo/);
    expect(e).toMatch(/au moins un gabarit/);
  });

  it("avertit sans carte à QR et pour le ruban 15x20", () => {
    const sansQr = laRuche();
    sansQr.gabarits = { choisis: [{ id: "pola", gabarit: "pola" }], accueil: [] };
    expect(controler(sansQr, true).some((c) => c.message.includes("pas de collecte"))).toBe(true);
    expect(controler(laRuche(), true).some((c) => c.message.includes("15x20"))).toBe(true);
  });
});

describe("réglages", () => {
  it("le schéma accepte les défauts et vide les champs facultatifs vides", () => {
    const r = reglagesParDefaut({ enseigne: "X", ville: "Y", dateInstallation: null });
    r.lieu.instagram = "";
    expect(reglagesSchema.parse(r).lieu.instagram).toBeNull();
  });

  it("code d'événement : R + 3 caractères sans I, L, O, 0, 1", () => {
    for (let i = 0; i < 200; i++) expect(genererCodeEvenement()).toMatch(/^R[A-HJKMNP-Z2-9]{3}$/);
  });
});
