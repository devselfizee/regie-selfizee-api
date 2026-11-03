// Composition du config.json d'un gabarit du kit habillé au studio (CDC page souvenir § 13.2, comme le
// studio Kalifun, lib/booth-zip.ts) : les zones du cadre remplacent celles du kit dans la zone dessinée ;
// tout le reste garde la valeur du kit (zones hors du dessin — cartes à QR de la « photo + deux cartes » —,
// 2inchCut, noms des fichiers…).
// Zone dessinée : la zone visible du kit (previewROI), ou toute la page pour les formats du studio qui la
// dessinent entière (bandelette + carte souvenir : la bande, ses miniatures, le QR et le code de séance).
// Zones de la borne posées au studio (docs/WEB-NIGHTLIFE.md) : QR → `qrHoles`, code de séance →
// `sessionCode`, date / heure de la prise de vue → `dynamicTexts` (clé proposée par la Régie, à valider
// côté borne).

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
type Alignement = "AlignLeft" | "AlignHCenter" | "AlignRight";
export interface CodeDeSeance {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color: string;
  align: Alignement;
  prefix: boolean;
}
export interface TexteDynamique {
  /** Ce que la borne écrit : date, heure ou les deux, de la prise de vue (save_date) */
  type: "date" | "time" | "datetime";
  format: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color: string;
  align: Alignement;
  font: string;
  bold: boolean;
  italic: boolean;
}
export type CompositionKit = {
  previewROI: Roi;
  holes: Trou[];
  shoots: Pose[];
  qrHoles?: Roi[];
  sessionCode?: CodeDeSeance | boolean;
} & Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ObjetFabric = Record<string, any>;

/** Formats du studio dessinés sur toute la page du kit, et non sur sa zone visible (previewROI). */
export const PAGE_ENTIERE: Record<string, { width: number; height: number }> = {
  "bandelette-carte": { width: 1240, height: 1844 },
};

/** La zone du kit que le cadre du studio remplace, selon son format. */
export function zoneDessinee(kit: { previewROI: Roi }, formatId?: string | null): Roi {
  const page = formatId ? PAGE_ENTIERE[formatId] : undefined;
  return page ? { x: 0, y: 0, ...page } : kit.previewROI;
}

const borne = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const dans = (t: Roi, r: Roi) => t.x >= r.x && t.y >= r.y && t.x + t.width <= r.x + r.width && t.y + t.height <= r.y + r.height;

const FORMATS_DATE: Record<TexteDynamique["type"], string> = { date: "DD/MM/YYYY", time: "HH:mm", datetime: "DD/MM/YYYY HH:mm" };
const TYPES_DATE: Record<string, TexteDynamique["type"]> = { date: "date", heure: "time", "date-heure": "datetime" };
const ALIGNEMENTS: Record<string, Alignement> = { left: "AlignLeft", center: "AlignHCenter", right: "AlignRight", justify: "AlignLeft" };
const ORIGINES: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };

/**
 * Le canvas du studio et sa projection vers la zone dessinée du kit. Repère de l'éditeur : les dimensions
 * du canvas enregistré (la page, dans le repère de ses objets) ; à défaut, le fond `_isSolidBg`. Pas le
 * fond d'abord : celui d'un modèle du catalogue posé sur la bande ne couvre que la moitié de la page.
 */
function lireCanvas(canvas: string, zone: Roi) {
  let objets: ObjetFabric[] = [];
  let largeur = 0;
  let hauteur = 0;
  try {
    const c = JSON.parse(canvas);
    objets = Array.isArray(c.objects) ? c.objects : [];
    largeur = Number(c.width) || 0;
    hauteur = Number(c.height) || 0;
  } catch {
    return null;
  }
  const fond = largeur && hauteur ? undefined : objets.find((o) => o._isSolidBg);
  const fondX = fond?.left ?? 0;
  const fondY = fond?.top ?? 0;
  const fondL = fond ? (fond.width ?? 0) * (fond.scaleX ?? 1) : largeur;
  const fondH = fond ? (fond.height ?? 0) * (fond.scaleY ?? 1) : hauteur;
  if (!fondL || !fondH) return null;
  const sx = zone.width / fondL;
  const sy = zone.height / fondH;

  /**
   * Boîte d'un objet dans le kit, avant rotation (la rotation se fait autour de son centre, comme
   * `sessionCode`), quelle que soit l'origine de l'objet.
   */
  const boite = (o: ObjetFabric) => {
    const l = (o.width ?? 0) * (o.scaleX ?? 1);
    const h = (o.height ?? 0) * (o.scaleY ?? 1);
    const a = ((o.angle ?? 0) * Math.PI) / 180;
    // Du point d'origine au centre, dans le repère de l'objet, puis tourné
    const dx = l * (0.5 - (ORIGINES[o.originX] ?? 0));
    const dy = h * (0.5 - (ORIGINES[o.originY] ?? 0));
    const cx = (o.left ?? 0) + dx * Math.cos(a) - dy * Math.sin(a);
    const cy = (o.top ?? 0) + dx * Math.sin(a) + dy * Math.cos(a);
    const w = Math.round(l * sx);
    const hh = Math.round(h * sy);
    return {
      x: zone.x + Math.round((cx - fondX) * sx - (l * sx) / 2),
      y: zone.y + Math.round((cy - fondY) * sy - (h * sy) / 2),
      width: w,
      height: hh,
      rotation: Math.round((o.angle ?? 0) * 100) / 100,
    };
  };
  return { objets, sx, sy, fondX, fondY, boite };
}

/**
 * Zones photo d'un cadre (objets Fabric `_isShootZone`), projetées du repère de l'éditeur vers la zone
 * dessinée du kit. Une zone a la photo de son `_shootIndex` ; les copies (`_shootCopie` : miniatures de
 * la carte souvenir) viennent après les zones principales et reprennent la photo de même numéro.
 */
export function zonesDuCadre(canvas: string, zone: Roi): { holes: Trou[]; shoots: Pose[] } {
  const lu = lireCanvas(canvas, zone);
  if (!lu) return { holes: [], shoots: [] };
  const zones = lu.objets
    .filter((o) => o._isShootZone)
    // Une copie au numéro 0 a perdu sa zone (supprimée au studio) : ignorée plus bas
    .map((o, i) => ({ o, copie: Boolean(o._shootCopie), numero: o._shootCopie ? Number(o._shootIndex) || 0 : Number(o._shootIndex) || i + 1 }))
    .sort((a, b) => Number(a.copie) - Number(b.copie) || a.numero - b.numero);
  // Numéros des photos ramenés à 0…n-1 (un shoot supprimé puis rajouté laisse un trou dans la suite)
  const numeros = [...new Set(zones.filter((z) => !z.copie).map((z) => z.numero))].sort((a, b) => a - b);

  const holes: Trou[] = [];
  const shoots: Pose[] = [];
  for (const { o, numero } of zones) {
    const shootId = numeros.indexOf(numero);
    if (shootId < 0) continue; // copie d'une photo qui n'existe plus
    const b = lu.boite(o);
    // Bornées à la zone dessinée : x + largeur ne la dépasse jamais
    const x = borne(b.x, zone.x, zone.x + zone.width);
    const y = borne(b.y, zone.y, zone.y + zone.height);
    const width = borne(b.width, 0, zone.x + zone.width - x);
    const height = borne(b.height, 0, zone.y + zone.height - y);
    holes.push({ shootId, x, y, width, height });
    shoots.push({ id: shootId, width, height });
  }
  return { holes, shoots };
}

/** Zones remplies par la borne (`_zoneBorne`), projetées vers la zone dessinée du kit. */
export function zonesBorneDuCadre(canvas: string, zone: Roi) {
  const qrHoles: Roi[] = [];
  let sessionCode: CodeDeSeance | null = null;
  const dynamicTexts: TexteDynamique[] = [];
  const lu = lireCanvas(canvas, zone);
  if (!lu) return { qrHoles, sessionCode, dynamicTexts };
  for (const o of lu.objets) {
    if (!o._zoneBorne) continue;
    const { x, y, width, height, rotation } = lu.boite(o);
    const couleur = typeof o.fill === "string" ? o.fill : "#000000";
    const align = ALIGNEMENTS[o.textAlign] ?? "AlignLeft";
    if (o._zoneBorne === "qr") qrHoles.push({ x, y, width, height });
    else if (o._zoneBorne === "code-seance") sessionCode ??= { x, y, width, height, rotation, color: couleur, align, prefix: true };
    else if (TYPES_DATE[o._zoneBorne]) {
      const type = TYPES_DATE[o._zoneBorne];
      dynamicTexts.push({
        type,
        format: FORMATS_DATE[type],
        x, y, width, height, rotation,
        color: couleur,
        align,
        font: String(o.fontFamily ?? ""),
        bold: o.fontWeight === "bold" || Number(o.fontWeight) >= 600,
        italic: o.fontStyle === "italic",
      });
    }
  }
  return { qrHoles, sessionCode, dynamicTexts };
}

/**
 * La composition du kit, avec les zones du cadre à la place de celles de la zone dessinée : zones photo,
 * QR, code de séance, textes dynamiques. Ce qui est hors de la zone dessinée garde la valeur du kit ; une
 * zone du kit recouverte par le dessin disparaît si le cadre n'en pose pas (un QR, un code…).
 */
export function compositionAvecCadre<T extends CompositionKit>(kit: T, canvas: string, zone: Roi = kit.previewROI): T {
  const cadre = zonesDuCadre(canvas, zone);
  // Cadre sans zone lisible : on garde le kit plutôt que de livrer une composition sans photo
  if (!cadre.holes.length) return kit;
  const borneCadre = zonesBorneDuCadre(canvas, zone);
  // Zones du kit hors de la zone dessinée (cartes à QR…) : gardées, avec leur pose
  const gardes = kit.holes.map((t, i) => ({ t, p: kit.shoots[i] })).filter(({ t }) => !dans(t, zone));
  const qrKit = (kit.qrHoles ?? []).filter((q) => !dans(q, zone));
  const codeKit = typeof kit.sessionCode === "object" && kit.sessionCode && !dans(kit.sessionCode, zone) ? kit.sessionCode : null;

  const resultat: T = {
    ...kit,
    holes: [...cadre.holes, ...gardes.map(({ t }) => t)],
    shoots: [...cadre.shoots, ...gardes.flatMap(({ t, p }) => (p ? [p] : [{ id: t.shootId, width: t.width, height: t.height }]))],
  };
  if (kit.qrHoles || borneCadre.qrHoles.length) resultat.qrHoles = [...borneCadre.qrHoles, ...qrKit];
  if (kit.sessionCode !== undefined || borneCadre.sessionCode) resultat.sessionCode = borneCadre.sessionCode ?? codeKit ?? false;
  if (borneCadre.dynamicTexts.length) (resultat as Record<string, unknown>).dynamicTexts = borneCadre.dynamicTexts;
  return resultat;
}
