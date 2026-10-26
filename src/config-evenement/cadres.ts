import { z } from "zod";
import { GABARITS, type Gabarit } from "./reglages.js";

// Formats du studio autorisés pour chaque gabarit du kit (le front filtre le studio avec la même table,
// regie-selfizee-web src/studio/regie/formatsKit.ts). Tous portrait 1240×1844 (10x15), sauf la bandelette
// dessinée sur sa moitié visible (620×1844) ; la carte souvenir et les deux cartes à QR viennent du kit.
export const FORMATS_PAR_GABARIT: Record<Gabarit, { formats: string[]; gabaritsStudio?: string[]; poses: number }> = {
  bandelette: { formats: ["marque-page"], gabaritsStudio: ["mp-4"], poses: 4 },
  pola: { formats: ["polaroid", "carte-postale-portrait"], poses: 1 },
  planche: { formats: ["polaroid-multishoot"], gabaritsStudio: ["polm-4"], poses: 4 },
  carte: { formats: ["polaroid", "carte-postale-portrait"], poses: 1 },
};

/** Plafond d'un cadre (rendu PNG + JSON Fabric avec ses illustrations), comme le studio Kalifun. */
export const TAILLE_MAX_CADRE = 25 * 1024 * 1024;

export const gabaritParam = z.enum(GABARITS);

const dataUrl = (type: "png" | "jpeg") =>
  z.string().regex(new RegExp(`^data:image/${type === "png" ? "png" : "(jpeg|png)"};base64,[A-Za-z0-9+/=]+$`), `Image ${type.toUpperCase()} attendue (data URL)`);

export const cadreSchema = z.object({
  nom: z.string().trim().min(1).max(120),
  formatId: z.string().min(1).max(60),
  gabaritStudioId: z.string().max(60).nullish(),
  nbPoses: z.number().int().min(0).max(12),
  canvas: z.string().min(2),
  image: dataUrl("png"),
  vignette: dataUrl("jpeg").nullish(),
});
export type CadreSaisi = z.infer<typeof cadreSchema>;

/** Message d'erreur si le cadre ne correspond pas au gabarit du kit, sinon null. */
export function verifierCadre(gabarit: Gabarit, c: CadreSaisi): string | null {
  const regle = FORMATS_PAR_GABARIT[gabarit];
  if (!regle.formats.includes(c.formatId)) return `Le format « ${c.formatId} » ne convient pas à ce gabarit (attendu : ${regle.formats.join(", ")}).`;
  if (regle.gabaritsStudio && c.gabaritStudioId && !regle.gabaritsStudio.includes(c.gabaritStudioId))
    return `Le gabarit « ${c.gabaritStudioId} » du studio ne convient pas (attendu : ${regle.gabaritsStudio.join(", ")}).`;
  if (c.nbPoses !== regle.poses) return `Ce gabarit attend ${regle.poses} pose${regle.poses > 1 ? "s" : ""}, le cadre en a ${c.nbPoses}.`;
  return null;
}
