import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import type { Reglages } from "./reglages.js";

// Illustrations des bornes (mémo « ILLUSTRATIONS-ADMIN-WEB », 05/11/2026) : sur le kit nightlife, les
// cases photo des cadres (page de choix du format, cadres de l'accueil) montrent des photos d'exemple,
// tirées au sort par la borne. Un événement peut fournir les siennes : copiées dans le zip, rangées par
// forme de case (`carre`, `portrait`, `paysage`), la borne prenant la racine si la forme manque.

/** Série des cases des cadres, et série distincte (facultative) des cadres de l'accueil. */
export const CIBLES = ["cadres", "accueil"] as const;
export type CibleIllustration = (typeof CIBLES)[number];
export type Forme = "carre" | "portrait" | "paysage";

/** Dossiers du zip lus par la borne. */
export const DOSSIER_ILLUSTRATIONS: Record<CibleIllustration, string> = { cadres: "illustrations", accueil: "illustrations-accueil" };

/** 20 au plus par série (mémo : 6 à 20, assez pour varier sans alourdir le zip). */
export const MAX_PAR_SERIE = 20;
const COTE_MAX = 1200; // la borne réduit à 800 px de large : inutile d'aller au-delà
const COTE_VIGNETTE = 240;

/** Forme de case d'une image : carré de 0,85 à 1,18 (5:6 à 6:5), portrait plus étroit, paysage plus large. */
export function formeDe(largeur: number, hauteur: number): Forme {
  const r = largeur / hauteur;
  return r < 0.85 ? "portrait" : r > 1.18 ? "paysage" : "carre";
}

/**
 * Image téléversée → JPEG d'au plus 1200 px de côté (orientation EXIF appliquée), sa vignette pour l'admin,
 * ses dimensions et sa forme. Refuse ce qui n'est pas une image.
 */
export async function preparerIllustration(source: Buffer) {
  const base = sharp(source, { failOn: "error" }).rotate();
  const image = await base.clone().resize(COTE_MAX, COTE_MAX, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const vignette = await base.clone().resize(COTE_VIGNETTE, COTE_VIGNETTE, { fit: "inside" }).jpeg({ quality: 72 }).toBuffer();
  const { width, height } = image.info;
  return { image: image.data, vignette, largeur: width, hauteur: height, forme: formeDe(width, height) };
}

/** Chemins des images dans le zip : <dossier>/<forme>/01.jpg… (numérotées par forme). */
export function cheminsDansLeZip(images: { cible: CibleIllustration; forme: string }[]): string[] {
  const compte = new Map<string, number>();
  return images.map((i) => {
    const dossier = `${DOSSIER_ILLUSTRATIONS[i.cible]}/${i.forme}`;
    const n = (compte.get(dossier) ?? 0) + 1;
    compte.set(dossier, n);
    return `${dossier}/${String(n).padStart(2, "0")}.jpg`;
  });
}

/**
 * Les images à copier dans le zip pour chaque série : photos de l'événement (« photos »), du client (« client ») ou d'une série de
 * la bibliothèque (« serie ») ; rien pour les séries du logiciel, la caméra ou les cases unies. Les photos
 * de l'événement passent avant une série (mémo) : un seul choix par série, donc pas de mélange.
 */
export async function illustrationsAExporter(reglages: Reglages, evenementId: number, lieuId: number) {
  const l = reglages.lieu;
  const sources: [CibleIllustration, string, number | null][] = [
    ["cadres", l.illustrations, l.illustrationsSerieId],
    ["accueil", l.illustrationsAccueil, l.illustrationsAccueilSerieId],
  ];
  const images: { cible: CibleIllustration; forme: string; image: Uint8Array }[] = [];
  for (const [cible, choix, serieId] of sources) {
    if (choix === "photos") {
      const p = await prisma.illustrationEvenement.findMany({ where: { configEvenementId: evenementId, cible }, select: { forme: true, image: true }, orderBy: { id: "asc" } });
      images.push(...p.map((i) => ({ cible, ...i })));
    } else if (choix === "client") {
      const p = await prisma.illustrationLieu.findMany({ where: { lieuId }, select: { forme: true, image: true }, orderBy: { id: "asc" } });
      images.push(...p.map((i) => ({ cible, ...i })));
    } else if (choix === "serie" && serieId) {
      const p = await prisma.illustrationSerieImage.findMany({ where: { serieId }, select: { forme: true, image: true }, orderBy: { id: "asc" } });
      images.push(...p.map((i) => ({ cible, ...i })));
    }
  }
  return images;
}
