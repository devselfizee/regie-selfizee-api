import { prisma } from "./prisma.js";
import { EXTENSIONS_VIDEO, extensionDuChemin, lireBuffer } from "./stockage.js";

// Aperçus des ventes d'après la table medias (synchro PikCloud). Le lien se fait par photo_uuid
// (transactions.pikcloud_uuid = medias.photo_uuid) ; quand il manque (borne qui ne l'envoie pas, JSON de séance
// pas encore reçu), par la borne et l'heure de prise de vue, connue dès l'annonce du média grâce au nom du fichier.
// Vignette JPEG en data URL (une balise img n'envoie pas le jeton) ; le fichier en taille réelle se lit par
// /api/medias/:uuid/fichier.

export interface ApercuMedia {
  /** uuid du média (routes /api/medias/:uuid) */
  uuid: string;
  vignette: string | null;
  video: boolean;
  /** Rapproché par borne et heure, faute de photo_uuid : peut se tromper si deux séances se suivent de près */
  approximatif?: boolean;
}

const selection = { uuid: true, photoUuid: true, borneId: true, mediaChemin: true, vignetteChemin: true, datePhoto: true } as const;
type MediaCandidat = { uuid: string; photoUuid: string | null; borneId: number | null; mediaChemin: string | null; vignetteChemin: string | null; datePhoto: Date | null };

const estVideo = (m: MediaCandidat) => EXTENSIONS_VIDEO.has(extensionDuChemin(m.mediaChemin ?? ""));
/** Une image plutôt qu'une vidéo, et une qui a sa vignette */
const meilleur = (actuel: MediaCandidat | undefined, m: MediaCandidat) => !actuel || (estVideo(actuel) && !estVideo(m)) || (!actuel.vignetteChemin && !!m.vignetteChemin);

async function versApercu(m: MediaCandidat, approximatif = false): Promise<ApercuMedia> {
  let vignette: string | null = null;
  if (m.vignetteChemin) {
    try {
      vignette = `data:image/jpeg;base64,${(await lireBuffer(m.vignetteChemin)).toString("base64")}`;
    } catch {
      vignette = null; // fichier manquant sur le disque (purgé)
    }
  }
  return { uuid: m.uuid, vignette, video: estVideo(m), ...(approximatif ? { approximatif: true } : {}) };
}

/** Média de chaque séance (photo_uuid → aperçu) : une image téléchargée de préférence, la plus ancienne prise de vue d'abord */
export async function apercusSeances(photoUuids: (string | null | undefined)[]): Promise<Map<string, ApercuMedia>> {
  const uuids = [...new Set(photoUuids.filter((u): u is string => !!u))];
  const resultat = new Map<string, ApercuMedia>();
  if (!uuids.length) return resultat;
  const medias = await prisma.media.findMany({
    where: { photoUuid: { in: uuids }, mediaStatut: "TELECHARGE" },
    select: selection,
    orderBy: [{ datePhoto: "asc" }, { id: "asc" }],
  });
  const choisis = new Map<string, MediaCandidat>();
  for (const m of medias) if (meilleur(choisis.get(m.photoUuid!), m)) choisis.set(m.photoUuid!, m);
  await Promise.all([...choisis].map(async ([photoUuid, m]) => resultat.set(photoUuid, await versApercu(m))));
  return resultat;
}

// Une séance : la prise de vue précède le paiement de quelques secondes à quelques minutes (choix du cadre,
// révélation, offre, « +1 pour un pote »). Au-delà de 10 minutes, ce n'est plus la même séance.
const AVANT_PAIEMENT_MS = 10 * 60_000;
const APRES_PAIEMENT_MS = 60_000;

/**
 * Média de chaque vente sans photo_uuid, par la borne et l'heure : le média de la même borne dont la prise de vue
 * est la plus proche du paiement, dans la fenêtre [paiement − 10 min, paiement + 1 min]. Clé : id de la vente.
 */
export async function apercusParBorneEtHeure(ventes: { id: bigint; borneId: number; horodatage: Date }[]): Promise<Map<bigint, ApercuMedia>> {
  const resultat = new Map<bigint, ApercuMedia>();
  if (!ventes.length) return resultat;
  const instants = ventes.map((v) => v.horodatage.getTime());
  const medias = await prisma.media.findMany({
    where: {
      borneId: { in: [...new Set(ventes.map((v) => v.borneId))] },
      mediaStatut: "TELECHARGE",
      datePhoto: { gte: new Date(Math.min(...instants) - AVANT_PAIEMENT_MS), lte: new Date(Math.max(...instants) + APRES_PAIEMENT_MS) },
    },
    select: selection,
    orderBy: [{ datePhoto: "asc" }, { id: "asc" }],
  });
  for (const v of ventes) {
    const paiement = v.horodatage.getTime();
    let choisi: MediaCandidat | undefined;
    let ecart = Infinity;
    for (const m of medias) {
      if (m.borneId !== v.borneId || !m.datePhoto) continue;
      const delai = paiement - m.datePhoto.getTime(); // positif : prise de vue avant le paiement
      if (delai < -APRES_PAIEMENT_MS || delai > AVANT_PAIEMENT_MS) continue;
      const e = Math.abs(delai);
      if (e < ecart || (e === ecart && meilleur(choisi, m))) {
        choisi = m;
        ecart = e;
      }
    }
    if (choisi) resultat.set(v.id, await versApercu(choisi, true));
  }
  return resultat;
}
