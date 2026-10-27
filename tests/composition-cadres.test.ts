import { readFileSync } from "node:fs";
import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compositionAvecCadre, zonesDuCadre } from "../src/config-evenement/composition.js";
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
    r.gabarits.choisis = ["bandelette", "pola"];
    const config = genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires: [], maintenant: new Date(), cadres: [{ gabarit: "bandelette", canvas }] });
    expect(config.compositions[0].holes).not.toEqual(kit.bandelette.holes);
    expect(config.compositions[1]).toEqual(kit.pola);
  });

  it("zip : config.json, cadre assemblé, aperçu refait, éléments du kit", async () => {
    const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
    r.gabarits.choisis = ["bandelette", "pola"];
    const maintenant = new Date("2026-10-27T10:00:00Z");
    const cadres = [{ gabarit: "bandelette", canvas, image: rendu }];
    const config = genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires: [], maintenant, cadres });
    const zip = await JSZip.loadAsync(await genererZip({ config, modele: lireModele(), choisis: r.gabarits.choisis, cadres, maintenant }));
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
});
