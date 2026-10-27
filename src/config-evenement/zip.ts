import { readdirSync, readFileSync } from "node:fs";
import JSZip from "jszip";
import sharp from "sharp";
import type { Gabarit } from "./reglages.js";
import type { Modele } from "./generation.js";
import type { Roi, Trou } from "./composition.js";

// Zip de l'événement chargé par la borne (CDC page souvenir § 13.4), sur le modèle du studio Kalifun
// (lib/booth-zip.ts) : config.json + cadres et aperçus des gabarits + éléments du kit (Tr, Backgrounds,
// Button), copiés de l'export étalon FJT5 dans modeles/evenement-nightlife/.
// Un gabarit habillé au studio : son cadre remplace le dessin du kit dans la zone dessinée (previewROI),
// le reste du cadre du kit (carte souvenir, cartes à QR) est gardé ; l'aperçu de l'accueil est refait.
// Les zones photo du config.json viennent de composition.ts.

const KIT = new URL("../../modeles/evenement-nightlife/", import.meta.url);
const lireKit = (chemin: string) => readFileSync(new URL(chemin, KIT));
const DOSSIERS_KIT = ["Tr", "Backgrounds", "Button"];
const DOSSIERS_VIDES = ["Form", "GreenScreen"];

export interface CadreZip {
  gabarit: string;
  /** Rendu du studio, data URL PNG, aux dimensions de la zone dessinée */
  image: string;
}

interface Config {
  compositions: { previewROI: Roi; holes: Trou[]; preview: string; overlay: string; lvOverlay?: string }[];
}

const depuisDataUrl = (d: string) => Buffer.from(d.slice(d.indexOf(",") + 1), "base64");

/** « 26/10/2026 14:05:09 », heure de Paris, comme Update/update.json des exports booth. */
function horodatageUpdate(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/** Zone dessinée bornée à l'image du kit (le cadre de la planche fait 1843 px de haut, son ROI 1844). */
async function roiDans(image: Buffer, roi: Roi): Promise<Roi> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const x = Math.min(roi.x, width);
  const y = Math.min(roi.y, height);
  return { x, y, width: Math.min(roi.width, width - x), height: Math.min(roi.height, height - y) };
}

/** Cadre du kit dont la zone dessinée est remplacée par le cadre du studio. */
export async function assemblerCadre(cadreKit: Buffer, rendu: Buffer, roiKit: Roi): Promise<Buffer> {
  const roi = await roiDans(cadreKit, roiKit);
  const redimensionne = await sharp(rendu).resize(roi.width, roi.height, { fit: "fill" }).png().toBuffer();
  const gomme = await sharp({ create: { width: roi.width, height: roi.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  return sharp(cadreKit)
    .ensureAlpha()
    .composite([
      { input: gomme, left: roi.x, top: roi.y, blend: "dest-out" },
      { input: redimensionne, left: roi.x, top: roi.y },
    ])
    .png()
    .toBuffer();
}

/**
 * Aperçu de l'accueil, dans le style de ceux du kit : le cadre sur fond blanc (zones photo blanches).
 * Hors de la zone dessinée (carte souvenir, cartes à QR), l'aperçu du kit est gardé tel quel.
 */
export async function assemblerApercu(apercuKit: Buffer, cadre: Buffer, roiKit: Roi): Promise<Buffer> {
  const { width: lc = 0, height: hc = 0 } = await sharp(cadre).metadata();
  const { width: la = 0, height: ha = 0 } = await sharp(apercuKit).metadata();
  // L'aperçu du kit couvre tout le cadre, ou seulement la zone dessinée (photo + deux cartes)
  const decalage = la === lc && ha === hc ? { x: 0, y: 0 } : { x: roiKit.x, y: roiKit.y };
  const roi = await roiDans(cadre, roiKit);
  const blanc = await sharp({ create: { width: roi.width, height: roi.height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  const cadreVisible = await sharp(cadre).extract({ left: decalage.x, top: decalage.y, width: la, height: ha }).png().toBuffer();
  return sharp(apercuKit)
    .composite([
      { input: blanc, left: roi.x - decalage.x, top: roi.y - decalage.y },
      { input: cadreVisible, left: 0, top: 0 },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Le zip complet : config.json, cadres et aperçus des gabarits choisis, éléments du kit. */
export async function genererZip({ config, modele, choisis, cadres, maintenant }: {
  config: Config;
  modele: Modele;
  choisis: Gabarit[];
  cadres: CadreZip[];
  maintenant: Date;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("config.json", JSON.stringify(config, null, 2));
  zip.file("Update/update.json", horodatageUpdate(maintenant));

  for (const g of choisis) {
    const kit = modele.gabarits[g];
    const cadreKit = lireKit(kit.overlay);
    const apercuKit = lireKit(kit.preview);
    const cadre = cadres.find((c) => c.gabarit === g);
    if (!cadre) {
      zip.file(kit.overlay, cadreKit);
      zip.file(kit.preview, apercuKit);
      continue;
    }
    const assemble = await assemblerCadre(cadreKit, depuisDataUrl(cadre.image), kit.previewROI);
    zip.file(kit.overlay, assemble);
    zip.file(kit.preview, await assemblerApercu(apercuKit, assemble, kit.previewROI));
  }
  // Le live view du pola pointe sur son cadre : déjà dans le zip
  for (const dossier of DOSSIERS_KIT) {
    for (const nom of readdirSync(new URL(`${dossier}/`, KIT))) zip.file(`${dossier}/${nom}`, lireKit(`${dossier}/${nom}`));
  }
  for (const dossier of DOSSIERS_VIDES) zip.folder(dossier);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
