import { prisma } from "./prisma.js";
import { EXTENSIONS_VIDEO, extensionDuChemin, lireBuffer } from "./stockage.js";

// Aperçus des ventes d'après la table medias (synchro PikCloud) : le lien se fait par photo_uuid
// (transactions.pikcloud_uuid = medias.photo_uuid). Vignette JPEG en data URL (une balise img n'envoie
// pas le jeton) ; le fichier en taille réelle se lit par /api/medias/:uuid/fichier.

export interface ApercuMedia {
  /** uuid du média (routes /api/medias/:uuid) */
  uuid: string;
  vignette: string | null;
  video: boolean;
}

/** Média de chaque séance (photo_uuid → aperçu) : une image téléchargée de préférence, la plus ancienne prise de vue d'abord */
export async function apercusSeances(photoUuids: (string | null | undefined)[]): Promise<Map<string, ApercuMedia>> {
  const uuids = [...new Set(photoUuids.filter((u): u is string => !!u))];
  const resultat = new Map<string, ApercuMedia>();
  if (!uuids.length) return resultat;
  const medias = await prisma.media.findMany({
    where: { photoUuid: { in: uuids }, mediaStatut: "TELECHARGE" },
    select: { uuid: true, photoUuid: true, mediaChemin: true, vignetteChemin: true, datePhoto: true },
    orderBy: [{ datePhoto: "asc" }, { id: "asc" }],
  });
  const choisis = new Map<string, (typeof medias)[number]>();
  for (const m of medias) {
    const actuel = choisis.get(m.photoUuid!);
    const video = (x: typeof m) => EXTENSIONS_VIDEO.has(extensionDuChemin(x.mediaChemin ?? ""));
    // Une image plutôt qu'une vidéo, et une qui a sa vignette
    if (!actuel || (video(actuel) && !video(m)) || (!actuel.vignetteChemin && m.vignetteChemin)) choisis.set(m.photoUuid!, m);
  }
  await Promise.all(
    [...choisis].map(async ([photoUuid, m]) => {
      let vignette: string | null = null;
      if (m.vignetteChemin) {
        try {
          vignette = `data:image/jpeg;base64,${(await lireBuffer(m.vignetteChemin)).toString("base64")}`;
        } catch {
          vignette = null; // fichier manquant sur le disque (purgé)
        }
      }
      resultat.set(photoUuid, { uuid: m.uuid, vignette, video: EXTENSIONS_VIDEO.has(extensionDuChemin(m.mediaChemin ?? "")) });
    })
  );
  return resultat;
}
