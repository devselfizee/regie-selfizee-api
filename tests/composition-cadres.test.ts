import { readFileSync } from "node:fs";
import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compositionAvecCadre, zoneDessinee, zonesDuCadre } from "../src/config-evenement/composition.js";
import { verifierCadre } from "../src/config-evenement/cadres.js";
import { genererConfig, lireModele } from "../src/config-evenement/generation.js";
import { reglagesParDefaut } from "../src/config-evenement/reglages.js";
import { genererZip } from "../src/config-evenement/zip.js";

// Cadre réel enregistré par le studio de la Régie : bandelette (marque-page 620×1844), 4 zones photo,
// canvas de l'éditeur en 269×800, rendu PNG en 620×1844.
const canvas = readFileSync(new URL("./fixtures/cadre-bandelette.json", import.meta.url), "utf8");
const rendu = `data:image/png;base64,${readFileSync(new URL("./fixtures/cadre-bandelette.png", import.meta.url)).toString("base64")}`;
const kit = lireModele().gabarits;

describe("composition d'un gabarit habillé au studio", () => {
  it("projette les zones du cadre dans la zone dessinée du kit", () => {
    const { holes, shoots } = zonesDuCadre(canvas, { x: 0, y: 0, width: 620, height: 1844 });
    expect(holes).toHaveLength(4);
    expect(holes.map((h) => h.shootId)).toEqual([0, 1, 2, 3]);
    // 225,96 × 176 px dans l'éditeur (269 × 800) → ×2,305 dans le cadre réel
    expect(holes[0]).toMatchObject({ x: 50, y: 37, width: 521, height: 406 });
    expect(shoots[0]).toEqual({ id: 0, width: 521, height: 406 });
    for (const h of holes) expect(h.x + h.width).toBeLessThanOrEqual(620);
  });

  it("bandelette : zones du cadre à gauche, carte souvenir du kit gardée (mini-photos, QR, code)", () => {
    const c = compositionAvecCadre(kit.bandelette, canvas);
    expect(c.holes).toHaveLength(8);
    expect(c.holes.slice(0, 4).every((h) => h.x + h.width <= 620)).toBe(true);
    expect(c.holes.slice(4)).toEqual(kit.bandelette.holes.filter((h) => h.x >= 620));
    expect(c.shoots).toHaveLength(8);
    expect(c.qrHoles).toEqual(kit.bandelette.qrHoles);
    expect(c.sessionCode).toEqual(kit.bandelette.sessionCode);
    expect(c["2inchCut"]).toBe(true);
    expect(c.overlay).toBe("Frames/strip_frame.png");
    expect(c.previewROI).toEqual(kit.bandelette.previewROI);
  });

  it("photo + deux cartes : le cadre est placé dans la zone de la photo, les cartes à QR restent", () => {
    // Même canvas, lu comme une photo pleine zone : seule la position compte ici
    const c = compositionAvecCadre(kit.carte, canvas);
    const roi = kit.carte.previewROI;
    const dessinees = c.holes.filter((h) => h.x >= roi.x && h.x + h.width <= roi.x + roi.width);
    expect(dessinees).toHaveLength(4);
    expect(c.holes.filter((h) => h.x < roi.x || h.x >= roi.x + roi.width)).toHaveLength(2);
    expect(c.qrHoles).toEqual(kit.carte.qrHoles);
  });

  it("le config.json ne change que les gabarits qui ont un cadre", () => {
    const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
    r.gabarits.choisis = [{ id: "bandelette", gabarit: "bandelette" }, { id: "pola", gabarit: "pola" }];
    const config = genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires: [], maintenant: new Date(), cadres: [{ compositionId: "bandelette", canvas }] });
    expect(config.compositions[0].holes).not.toEqual(kit.bandelette.holes);
    expect(config.compositions[1]).toEqual(kit.pola);
  });

  it("zip : config.json, cadre assemblé, aperçu refait, éléments du kit", async () => {
    const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
    r.gabarits.choisis = [{ id: "bandelette", gabarit: "bandelette" }, { id: "pola", gabarit: "pola" }];
    const maintenant = new Date("2026-10-27T10:00:00Z");
    const cadres = [{ compositionId: "bandelette", canvas, image: rendu }];
    const config = genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires: [], maintenant, cadres });
    const zip = await JSZip.loadAsync(await genererZip({ config, modele: lireModele(), reglages: r, cadres, maintenant }));
    const noms = Object.keys(zip.files);
    for (const n of ["config.json", "Update/update.json", "Frames/strip_frame.png", "Frames/strip_preview.jpg", "Frames/polaroid_frame.png", "Frames/polaroid_preview.jpg", "Tr/fr_FR.png", "Backgrounds/welcom.jpg", "Button/rebound.png", "Form/", "GreenScreen/"])
      expect(noms).toContain(n);
    expect(noms).not.toContain("Frames/multiShoot_frame.png");
    expect(await zip.file("Update/update.json")!.async("string")).toBe("27/10/2026 11:00:00");
    expect(JSON.parse(await zip.file("config.json")!.async("string")).compositions[0].holes).toEqual(config.compositions[0].holes);

    // Cadre assemblé : taille du kit, zone dessinée = rendu du studio, carte souvenir du kit intacte
    const cadre = await zip.file("Frames/strip_frame.png")!.async("nodebuffer");
    expect(await sharp(cadre).metadata()).toMatchObject({ width: 1240, height: 1844 });
    const pixel = async (img: Buffer, x: number, y: number) =>
      [...(await sharp(img).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
    const kitStrip = readFileSync(new URL("../modeles/evenement-nightlife/Frames/strip_frame.png", import.meta.url));
    expect(await pixel(cadre, 900, 1700)).toEqual(await pixel(kitStrip, 900, 1700));
    const studio = Buffer.from(rendu.split(",")[1], "base64");
    expect(await pixel(cadre, 10, 10)).toEqual(await pixel(studio, 10, 10));
    expect(await sharp(await zip.file("Frames/strip_preview.jpg")!.async("nodebuffer")).metadata()).toMatchObject({ width: 1240, height: 1844, format: "jpeg" });
  }, 60_000);

  it("zip : un même gabarit plusieurs fois, fichiers numérotés, chacun son cadre", async () => {
    const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
    r.gabarits = { choisis: [{ id: "bandelette", gabarit: "bandelette" }, { id: "bandelette-k2", gabarit: "bandelette" }], accueil: ["bandelette-k2"] };
    const maintenant = new Date("2026-10-28T10:00:00Z");
    const cadres = [{ compositionId: "bandelette-k2", canvas, image: rendu }];
    const config = genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires: [], maintenant, cadres });
    expect(config.compositions.map((c) => c.overlay)).toEqual(["Frames/strip_frame.png", "Frames/strip_frame_1.png"]);
    expect(config.compositions[0].holes).toEqual(kit.bandelette.holes);
    expect(config.compositions[1].holes).not.toEqual(kit.bandelette.holes);
    expect(config.userSettings.welcomeFormats).toEqual(["strip_preview_1"]);
    const zip = await JSZip.loadAsync(await genererZip({ config, modele: lireModele(), reglages: r, cadres, maintenant }));
    for (const n of ["Frames/strip_frame.png", "Frames/strip_preview.jpg", "Frames/strip_frame_1.png", "Frames/strip_preview_1.jpg"]) expect(Object.keys(zip.files)).toContain(n);
    const kitStrip = readFileSync(new URL("../modeles/evenement-nightlife/Frames/strip_frame.png", import.meta.url));
    expect(Buffer.compare(await zip.file("Frames/strip_frame.png")!.async("nodebuffer"), kitStrip)).toBe(0);
    expect(Buffer.compare(await zip.file("Frames/strip_frame_1.png")!.async("nodebuffer"), kitStrip)).not.toBe(0);
  }, 60_000);
});

// Bandelette dessinée sur la page entière (format « bandelette-carte ») : éditeur en 620×922, soit ×2
// vers la page du kit (1240×1844). 4 zones sur la bande, leurs 4 copies (miniatures de la carte), le QR
// (groupe d'origine centrale), le code de séance et deux textes dynamiques, dont un tourné de 90°.
const zone = (i: number, copie = false) =>
  copie
    ? { type: "Rect", originX: "left", originY: "top", left: 395, top: 225 + i * 107, width: 141, height: 100, _isShootZone: true, _shootIndex: i + 1, _shootCopie: true }
    : { type: "Rect", originX: "left", originY: "top", left: 20, top: 40 + i * 200, width: 270, height: 190, _isShootZone: true, _shootIndex: i + 1 };
const qr = { type: "Group", originX: "center", originY: "center", left: 516, top: 810, width: 100, height: 100, _zoneBorne: "qr" };
const code = { type: "Textbox", originX: "left", originY: "top", left: 328, top: 885, width: 77, height: 14, fill: "#f0c400", textAlign: "left", _zoneBorne: "code-seance" };
const dateHeure = { type: "Textbox", originX: "left", originY: "top", left: 328, top: 860, width: 200, height: 20, fontSize: 16, fill: "#ffffff", textAlign: "center", fontFamily: "Figtree", fontWeight: "bold", _zoneBorne: "date-heure" };
const heure = { type: "Textbox", originX: "left", originY: "top", left: 600, top: 100, width: 100, height: 20, fontSize: 12, angle: 90, fill: "#ffffff", textAlign: "left", fontFamily: "Inter", fontStyle: "italic", _zoneBorne: "heure" };
const pageEntiere = (objets: object[]) => JSON.stringify({ width: 620, height: 922, objects: objets });
const toutes = [0, 1, 2, 3].flatMap((i) => [zone(i), zone(i, true)]);

describe("bandelette dessinée sur la page entière (bande + carte souvenir)", () => {
  const zoneBc = zoneDessinee(kit.bandelette, "bandelette-carte");

  it("la zone dessinée est la page entière ; « marque-page » garde la zone visible", () => {
    expect(zoneBc).toEqual({ x: 0, y: 0, width: 1240, height: 1844 });
    expect(zoneDessinee(kit.bandelette, "marque-page")).toEqual(kit.bandelette.previewROI);
    expect(zoneDessinee(kit.bandelette, null)).toEqual(kit.bandelette.previewROI);
  });

  it("zones de la bande puis miniatures, chacune avec la photo de son numéro", () => {
    const c = compositionAvecCadre(kit.bandelette, pageEntiere([...toutes, qr, code]), zoneBc);
    expect(c.holes.map((h) => h.shootId)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(c.holes[0]).toEqual({ shootId: 0, x: 40, y: 80, width: 540, height: 380 });
    expect(c.holes[4]).toEqual({ shootId: 0, x: 790, y: 450, width: 282, height: 200 });
    expect(c.shoots).toHaveLength(8);
    expect(c.previewROI).toEqual(kit.bandelette.previewROI);
    expect(c["2inchCut"]).toBe(true);
  });

  it("QR, code de séance et textes dynamiques du studio, à la place de ceux du kit", () => {
    const c = compositionAvecCadre(kit.bandelette, pageEntiere([...toutes, qr, code, dateHeure, heure]), zoneBc);
    expect(c.qrHoles).toEqual([{ x: 932, y: 1520, width: 200, height: 200 }]);
    expect(c.sessionCode).toEqual({ x: 656, y: 1770, width: 154, height: 28, rotation: 0, color: "#f0c400", align: "AlignLeft", prefix: true });
    // Mémo de la borne du 03/11 : police Qt, position, alignement, dateFormat DD/MM/YYYY ; pas de textKey
    expect(c.dynamicTexts).toEqual([
      {
        font: "Figtree,-1,32,5,700,0,0,0,0,0,0,0,0,0,0,1",
        position: { x: 656, y: 1720, width: 400, height: 40 },
        color: "#ffffff", alignment: ["AlignVCenter", "AlignHCenter"], dateFormat: "DD/MM/YYYY HH:mm",
      },
      {
        font: "Inter,-1,24,5,400,1,0,0,0,0,0,0,0,0,0,1",
        // Dépassait la page de 40 px : ramené dans la planche
        position: { x: 1080, y: 280, width: 160, height: 40 },
        color: "#ffffff", alignment: ["AlignVCenter", "AlignLeft"], dateFormat: "HH:mm",
      },
    ]);
  });

  it("QR toujours carré et dans la planche (mémo de la borne)", () => {
    // Étiré en largeur : carré du plus petit côté, centré
    const etire = { ...qr, width: 150, scaleX: 1 };
    const c = compositionAvecCadre(kit.bandelette, pageEntiere([...toutes, etire]), zoneBc);
    expect(c.qrHoles).toEqual([{ x: 932, y: 1520, width: 200, height: 200 }]);
    // Qui dépasse de la page : pas posé (sinon x négatif → événement refusé par la borne)
    const dehors = { ...qr, left: 10 };
    expect(compositionAvecCadre(kit.bandelette, pageEntiere([...toutes, dehors]), zoneBc).qrHoles).toEqual([]);
  });

  it("sans QR ni code posés au studio : ceux du kit, recouverts par le dessin, disparaissent", () => {
    const c = compositionAvecCadre(kit.bandelette, pageEntiere(toutes), zoneBc);
    expect(c.qrHoles).toEqual([]);
    expect(c.sessionCode).toBe(false);
    expect(c.dynamicTexts).toBeUndefined();
  });

  it("modèle du catalogue posé sur la bande : son fond (moitié de page) ne sert pas de repère", () => {
    const fondDuModele = { type: "Rect", originX: "left", originY: "top", left: 0, top: 0, width: 310, height: 922, _isSolidBg: true, _fromCatalogue: true };
    const c = compositionAvecCadre(kit.bandelette, pageEntiere([fondDuModele, ...toutes, qr]), zoneBc);
    expect(c.holes[0]).toEqual({ shootId: 0, x: 40, y: 80, width: 540, height: 380 });
    expect(c.holes[4]).toEqual({ shootId: 0, x: 790, y: 450, width: 282, height: 200 });
    expect(c.qrHoles).toEqual([{ x: 932, y: 1520, width: 200, height: 200 }]);
  });

  it("une miniature dont la zone a été supprimée (numéro 0) est ignorée", () => {
    const orpheline = { ...zone(3, true), _shootIndex: 0 };
    const c = compositionAvecCadre(kit.bandelette, pageEntiere([zone(0), zone(1), zone(2), zone(0, true), orpheline, qr]), zoneBc);
    expect(c.holes.map((h) => h.shootId)).toEqual([0, 1, 2, 0]);
  });

  it("bande seule (marque-page) : QR et code de la carte du kit gardés, même avec un QR posé sur la bande", () => {
    const c = compositionAvecCadre(kit.bandelette, canvas);
    expect(c.qrHoles).toEqual(kit.bandelette.qrHoles);
    expect(c.sessionCode).toEqual(kit.bandelette.sessionCode);
  });

  it("zip : le rendu couvre tout le cadre du kit", async () => {
    const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
    r.gabarits.choisis = [{ id: "bandelette", gabarit: "bandelette" }];
    const maintenant = new Date("2026-11-03T10:00:00Z");
    const rouge = await sharp({ create: { width: 1240, height: 1844, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const cadres = [{ compositionId: "bandelette", canvas: pageEntiere([...toutes, qr, code]), formatId: "bandelette-carte", image: `data:image/png;base64,${rouge.toString("base64")}` }];
    const config = genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires: [], maintenant, cadres });
    expect(config.compositions[0].qrHoles).toEqual([{ x: 932, y: 1520, width: 200, height: 200 }]);
    const zip = await JSZip.loadAsync(await genererZip({ config, modele: lireModele(), reglages: r, cadres, maintenant }));
    const cadre = await zip.file("Frames/strip_frame.png")!.async("nodebuffer");
    const pixel = async (x: number, y: number) => [...(await sharp(cadre).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
    // La carte souvenir aussi vient du studio
    expect(await pixel(900, 1700)).toEqual([255, 0, 0, 255]);
    expect(await pixel(10, 10)).toEqual([255, 0, 0, 255]);
  }, 60_000);
});

// Photo 10x15 paysage (demande du boss, 04/11/2026) : page 1844×1240, photo pleine page, cadre du kit
// transparent. Éditeur en 922×620, soit ×2 vers la page.
describe("photo 10x15 paysage", () => {
  const paysage = JSON.stringify({
    width: 922,
    height: 620,
    objects: [
      { type: "Rect", originX: "left", originY: "top", left: 40, top: 30, width: 600, height: 560, _isShootZone: true, _shootIndex: 1 },
      { type: "Textbox", originX: "left", originY: "top", left: 680, top: 560, width: 200, height: 20, fontSize: 16, fill: "#ffffff", textAlign: "center", fontFamily: "Inter", _zoneBorne: "date" },
    ],
  });

  it("gabarit du kit : page paysage, une photo pleine page, cadre et aperçu dans le zip du kit", () => {
    expect(kit.paysage.previewROI).toEqual({ x: 0, y: 0, width: 1844, height: 1240 });
    expect(kit.paysage.holes).toEqual([{ shootId: 0, x: 0, y: 0, width: 1844, height: 1240 }]);
    expect(kit.paysage).toMatchObject({ overlay: "Frames/paysage_frame.png", preview: "Frames/paysage_preview.jpg", sessionCode: false });
  });

  it("le studio n'y dessine qu'en carte postale paysage, une pose", () => {
    const cadre = { nom: "x", formatId: "carte-postale-paysage", nbPoses: 1, canvas: "{}", image: "data:image/png;base64,AA" };
    expect(verifierCadre("paysage", cadre)).toBeNull();
    expect(verifierCadre("paysage", { ...cadre, formatId: "carte-postale-portrait" })).toMatch(/ne convient pas/);
    expect(verifierCadre("paysage", { ...cadre, nbPoses: 2 })).toMatch(/1 pose/);
  });

  it("zones du cadre projetées sur la page paysage (×2), date dynamique comprise", () => {
    const c = compositionAvecCadre(kit.paysage, paysage);
    expect(c.holes).toEqual([{ shootId: 0, x: 80, y: 60, width: 1200, height: 1120 }]);
    expect(c.dynamicTexts).toEqual([expect.objectContaining({ position: { x: 1360, y: 1120, width: 400, height: 40 }, dateFormat: "DD/MM/YYYY" })]);
  });

  it("zip : cadre du studio en 1844×1240, aperçu refait", async () => {
    const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
    r.gabarits = { choisis: [{ id: "paysage", gabarit: "paysage" }], accueil: ["paysage"] };
    const maintenant = new Date("2026-11-04T10:00:00Z");
    const png = await sharp({ create: { width: 1844, height: 1240, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const cadres = [{ compositionId: "paysage", canvas: paysage, image: `data:image/png;base64,${png.toString("base64")}` }];
    const config = genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires: [], maintenant, cadres });
    expect(config.userSettings.welcomeFormats).toEqual(["paysage_preview"]);
    const zip = await JSZip.loadAsync(await genererZip({ config, modele: lireModele(), reglages: r, cadres, maintenant }));
    const cadre = await zip.file("Frames/paysage_frame.png")!.async("nodebuffer");
    expect(await sharp(cadre).metadata()).toMatchObject({ width: 1844, height: 1240 });
    expect([...(await sharp(cadre).extract({ left: 900, top: 600, width: 1, height: 1 }).raw().toBuffer())]).toEqual([200, 0, 0, 255]);
    expect(await sharp(await zip.file("Frames/paysage_preview.jpg")!.async("nodebuffer")).metadata()).toMatchObject({ width: 1844, height: 1240, format: "jpeg" });
  }, 60_000);
});
