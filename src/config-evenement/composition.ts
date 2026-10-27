// Composition du config.json d'un gabarit du kit habillé au studio (CDC page souvenir § 13.2, comme le
// studio Kalifun, lib/booth-zip.ts) : les zones photo du cadre remplacent celles du kit dans la zone
// dessinée (previewROI) ; tout le reste garde la valeur du kit (zones hors du dessin — carte souvenir de
// la bandelette, cartes à QR —, qrHoles, sessionCode, 2inchCut, noms des fichiers…).

export interface Roi {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Trou {
  shootId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Pose {
  id: number;
  width: number;
  height: number;
}
export type CompositionKit = { previewROI: Roi; holes: Trou[]; shoots: Pose[] } & Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ObjetFabric = Record<string, any>;

const borne = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const dansRoi = (t: Trou, r: Roi) => t.x >= r.x && t.y >= r.y && t.x + t.width <= r.x + r.width && t.y + t.height <= r.y + r.height;

/**
 * Zones photo d'un cadre (objets Fabric `_isShootZone`, dans l'ordre de `_shootIndex`), projetées du
 * repère de l'éditeur vers la zone dessinée du kit. Repère de l'éditeur : le fond `_isSolidBg` s'il
 * existe, sinon les dimensions du canvas (le fond par défaut n'est pas enregistré).
 */
export function zonesDuCadre(canvas: string, roi: Roi): { holes: Trou[]; shoots: Pose[] } {
  let objets: ObjetFabric[] = [];
  let largeur = 0;
  let hauteur = 0;
  try {
    const c = JSON.parse(canvas);
    objets = Array.isArray(c.objects) ? c.objects : [];
    largeur = Number(c.width) || 0;
    hauteur = Number(c.height) || 0;
  } catch {
    return { holes: [], shoots: [] };
  }
  const fond = objets.find((o) => o._isSolidBg);
  const fondX = fond?.left ?? 0;
  const fondY = fond?.top ?? 0;
  const fondL = (fond ? (fond.width ?? 0) * (fond.scaleX ?? 1) : largeur) || largeur;
  const fondH = (fond ? (fond.height ?? 0) * (fond.scaleY ?? 1) : hauteur) || hauteur;
  if (!fondL || !fondH) return { holes: [], shoots: [] };
  const sx = roi.width / fondL;
  const sy = roi.height / fondH;

  const holes: Trou[] = [];
  const shoots: Pose[] = [];
  objets
    .filter((o) => o._isShootZone)
    .sort((a, b) => (a._shootIndex ?? 0) - (b._shootIndex ?? 0))
    .forEach((z, shootId) => {
      const l = (z.width ?? 0) * (z.scaleX ?? 1);
      const h = (z.height ?? 0) * (z.scaleY ?? 1);
      // Coin haut gauche, quelle que soit l'origine de l'objet
      const gauche = (z.left ?? 0) - (z.originX === "center" ? l / 2 : z.originX === "right" ? l : 0);
      const haut = (z.top ?? 0) - (z.originY === "center" ? h / 2 : z.originY === "bottom" ? h : 0);
      const x = borne(Math.round((gauche - fondX) * sx), 0, roi.width);
      const y = borne(Math.round((haut - fondY) * sy), 0, roi.height);
      // Bornées à la zone dessinée : x + largeur ne la dépasse jamais
      const w = borne(Math.round(l * sx), 0, roi.width - x);
      const hh = borne(Math.round(h * sy), 0, roi.height - y);
      holes.push({ shootId, x: roi.x + x, y: roi.y + y, width: w, height: hh });
      shoots.push({ id: shootId, width: w, height: hh });
    });
  return { holes, shoots };
}

/** La composition du kit, avec les zones photo du cadre à la place de celles de la zone dessinée. */
export function compositionAvecCadre<T extends CompositionKit>(kit: T, canvas: string): T {
  const roi = kit.previewROI;
  const cadre = zonesDuCadre(canvas, roi);
  // Cadre sans zone lisible : on garde le kit plutôt que de livrer une composition sans photo
  if (!cadre.holes.length) return kit;
  // Zones du kit hors de la zone dessinée (carte souvenir, cartes à QR) : gardées, avec leur pose
  const gardes = kit.holes.map((t, i) => ({ t, p: kit.shoots[i] })).filter(({ t }) => !dansRoi(t, roi));
  return {
    ...kit,
    holes: [...cadre.holes, ...gardes.map(({ t }) => t)],
    shoots: [...cadre.shoots, ...gardes.flatMap(({ t, p }) => (p ? [p] : [{ id: t.shootId, width: t.width, height: t.height }]))],
  };
}
