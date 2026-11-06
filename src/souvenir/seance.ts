import sharp from "sharp";
import type { Media } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { cheminAbsolu, extensionDuChemin } from "../lib/stockage.js";
import { avecGrilleDuLieu, avecInfosDuLieu, reglagesSchema, type Reglages } from "../config-evenement/reglages.js";
import { infosLieuDe } from "../config-evenement/acces.js";
import { grilleEffective } from "../tarifs/grille.js";
import { ecrireJeton, signature, type JetonSouvenir } from "./jeton.js";

// Ce que la page souvenir affiche pour une séance (CDC § 1.2, § 4.1) : l'événement (lieu, jeu, tarifs, photos
// d'exemple) et les visuels reçus de PikCloud (table medias), en URLs signées et expirantes.

const JOUR = 86_400_000;
/** Photos et lien gardés 90 jours après la séance (CDC § 9.2). */
export const CONSERVATION_JOURS = 90;
/** Durée de validité des URLs des visuels. */
const VALIDITE_S = 6 * 3600;
/** Côté le plus long d'une photo servie : jamais le fichier en pleine définition (CDC § 3). */
export const COTE_WEB = 1600;
const IMAGES_FIXES = new Set(["jpg", "jpeg", "png", "webp"]);
const ILLUSTRATIONS_MAX = 5;

export type TypeVisuel = "photo" | "gif";

export interface Visuel {
  type: TypeVisuel;
  url: string;
  largeur: number;
  hauteur: number;
}

export interface SeanceSouvenir {
  token: string;
  evenement: {
    code: string;
    lieu: string;
    ville: string;
    jeu: { actif: boolean; lots: Reglages["tarifs"]["jeu"]["lots"]; maxLotsParJour: number };
    reimpressionWeb: boolean;
    tarifs: { paliers: { from: number; unitPrice: number }[]; populaire?: number; libellePopulaire?: string };
    /** Ton des textes réglé sur l'événement (club, chic…) */
    ton: Reglages["lieu"]["ton"];
    /** Infos du lieu saisies dans la Régie (onglet Communication) : avis Google et réseaux, pour les mails */
    liens: { avisGoogle: string | null; instagram: string | null; tiktok: string | null; hashtag: string | null };
    /** Photos d'exemple de l'événement (vide : la page prend les siennes) */
    illustrations: string[];
  };
  etat: "disponible" | "en-attente" | "expiree";
  prisLe?: string;
  codeSeance?: string;
  visuels: Visuel[];
}

/** URL absolue et signée d'un fichier servi par /souvenir/v1. */
function urlSignee(base: string, chemin: string): string {
  const { exp, sig } = signature(chemin, VALIDITE_S);
  return `${base}/souvenir/v1${chemin}?exp=${exp}&sig=${sig}`;
}

/** Dimensions affichées : celles du fichier, réduites au côté web pour une photo fixe. */
async function dimensions(m: Media, gif: boolean): Promise<{ largeur: number; hauteur: number } | null> {
  try {
    const meta = await sharp(cheminAbsolu(m.mediaChemin!), { animated: gif }).metadata();
    // Orientation EXIF 5 à 8 : l'image est tournée d'un quart de tour à l'affichage
    const tourne = (meta.orientation ?? 1) >= 5;
    let largeur = tourne ? meta.height! : meta.width!;
    let hauteur = tourne ? meta.width! : (gif ? meta.pageHeight ?? meta.height! : meta.height!);
    if (!gif) {
      const r = Math.min(1, COTE_WEB / Math.max(largeur, hauteur));
      largeur = Math.round(largeur * r);
      hauteur = Math.round(hauteur * r);
    }
    return { largeur, hauteur };
  } catch {
    return null; // fichier absent ou illisible : visuel ignoré
  }
}

/** Séances de test (is_fake, testMode) montrées seulement si SOUVENIR_SEANCES_TEST=1 (recette). */
const avecTests = () => process.env.SOUVENIR_SEANCES_TEST === "1";

/**
 * La séance du jeton, ou null si l'événement n'existe pas (404). Une séance pas encore reçue est « en attente »
 * (le QR peut être scanné avant l'arrivée du média) ; au-delà de 90 jours, ou purgée, elle a expiré.
 */
export async function lireSeanceSouvenir(j: JetonSouvenir, base: string, maintenant = Date.now()): Promise<SeanceSouvenir | null> {
  const e = await prisma.configEvenement.findUnique({
    where: { code: j.code },
    include: { lieu: { select: { id: true, enseigne: true, ville: true, infosBorne: true } } },
  });
  if (!e) return null;
  const [tarifsLieu, infosLieu, medias] = await Promise.all([
    grilleEffective(e.lieuId),
    infosLieuDe(e.lieu),
    prisma.media.findMany({
      where: { codeEvent: j.code, photoUuid: j.photoUuid, ...(avecTests() ? {} : { test: false }) },
      orderBy: { id: "asc" },
    }),
  ]);
  // Réglages tels que la borne les a reçus : grille et infos du lieu reprises
  const r = avecInfosDuLieu(avecGrilleDuLieu(reglagesSchema.parse(e.reglages), tarifsLieu.grille), infosLieu);

  const evenement: SeanceSouvenir["evenement"] = {
    code: e.code,
    lieu: r.lieu.nom || e.lieu.enseigne,
    ville: r.lieu.ville ?? e.lieu.ville ?? "",
    jeu: { actif: r.tarifs.jeu.actif, lots: r.tarifs.jeu.lots, maxLotsParJour: r.tarifs.jeu.maxLotsParJour },
    reimpressionWeb: r.tarifs.reimpressionWeb,
    tarifs: {
      paliers: r.tarifs.paliers.map((p) => ({ from: p.de, unitPrice: p.prixCents / 100 })),
      ...(r.tarifs.palierMisEnAvant ? { populaire: r.tarifs.palierMisEnAvant, libellePopulaire: r.tarifs.libelleMisEnAvant || undefined } : {}),
    },
    ton: r.lieu.ton,
    liens: { avisGoogle: r.lieu.avisGoogleUrl, instagram: r.lieu.instagram, tiktok: r.lieu.tiktok, hashtag: r.lieu.hashtag },
    illustrations: await illustrationsDe(r, e.id, base),
  };

  const token = ecrireJeton(j.code, j.photoUuid);
  // Date de la séance : enregistrement sur la borne, à défaut prise de vue ou réception
  const date = medias.map((m) => m.dateSave ?? m.datePhoto).find(Boolean) ?? null;
  const brut = medias.map((m) => m.brut as { session_code?: unknown } | null).find((b) => typeof b?.session_code === "string");
  const codeSeance = brut ? String(brut.session_code) : undefined;
  const commun = { token, evenement, ...(codeSeance ? { codeSeance } : {}) };

  const reference = date?.getTime() ?? medias[0]?.createdAt.getTime() ?? null;
  const expiree = (reference !== null && maintenant - reference > CONSERVATION_JOURS * JOUR) || medias.some((m) => m.mediaStatut === "PURGE");
  if (expiree) return { ...commun, etat: "expiree", ...(date ? { prisLe: date.toISOString() } : {}), visuels: [] };

  const visuels: Visuel[] = [];
  for (const m of medias) {
    if (m.mediaStatut !== "TELECHARGE" || !m.mediaChemin) continue;
    const ext = extensionDuChemin(m.mediaChemin);
    const gif = ext === "gif";
    if (!gif && !IMAGES_FIXES.has(ext)) continue; // vidéos : pas encore de story (dérivés à générer, CDC GENERATION-GIF-STORY)
    const d = await dimensions(m, gif);
    if (d) visuels.push({ type: gif ? "gif" : "photo", url: urlSignee(base, `/fichiers/${m.uuid}`), ...d });
  }
  // Photo d'abord, puis le GIF (ordre du carrousel)
  visuels.sort((a, b) => Number(a.type === "gif") - Number(b.type === "gif"));
  if (!visuels.length) return { ...commun, etat: "en-attente", visuels: [] };
  return { ...commun, etat: "disponible", prisLe: (date ?? new Date(reference!)).toISOString(), visuels };
}

/** Photos d'exemple choisies pour l'événement (les siennes ou une série de la bibliothèque), en URLs signées. */
async function illustrationsDe(r: Reglages, evenementId: number, base: string): Promise<string[]> {
  const l = r.lieu;
  if (l.illustrations === "photos") {
    const p = await prisma.illustrationEvenement.findMany({ where: { configEvenementId: evenementId, cible: "cadres" }, select: { id: true }, orderBy: { id: "asc" }, take: ILLUSTRATIONS_MAX });
    return p.map((i) => urlSignee(base, `/illustrations/e/${i.id}`));
  }
  if (l.illustrations === "serie" && l.illustrationsSerieId) {
    const p = await prisma.illustrationSerieImage.findMany({ where: { serieId: l.illustrationsSerieId }, select: { id: true }, orderBy: { id: "asc" }, take: ILLUSTRATIONS_MAX });
    return p.map((i) => urlSignee(base, `/illustrations/s/${i.id}`));
  }
  return []; // séries du logiciel (festif, chic) : la page souvenir a les siennes
}

/**
 * Code de séance imprimé (6 caractères) → jeton de la page souvenir, sur les 90 derniers jours (CDC § 3) ; null si
 * inconnu. En cas de doublon (improbable), la séance la plus récente.
 */
export async function jetonDuCodeSeance(code: string, maintenant = Date.now()): Promise<string | null> {
  const m = await prisma.media.findFirst({
    where: {
      brut: { path: ["session_code"], equals: code },
      photoUuid: { not: null },
      ...(avecTests() ? {} : { test: false }),
      createdAt: { gte: new Date(maintenant - CONSERVATION_JOURS * JOUR) },
    },
    orderBy: { id: "desc" },
    select: { codeEvent: true, photoUuid: true },
  });
  return m?.photoUuid ? ecrireJeton(m.codeEvent, m.photoUuid) : null;
}
