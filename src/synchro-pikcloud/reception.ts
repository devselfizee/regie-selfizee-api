import { Prisma, type FichierStatut, type Media } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { sha256Payload } from "../ingestion/journal.js";
import { echec, succes, type EntreeReponse } from "./codes.js";
import { hotesAutorises } from "./config.js";
import { verifierLien } from "./telechargement.js";

// Réception d'un appel du webhook PikCloud (contrat du 04/11/2026) : une ligne `medias` par séance
// (code_event + filename), créée au premier fichier annoncé, JSON ou média, dans n'importe quel ordre.
// On ne télécharge rien ici (réponse en moins de 10 s) : chaque fichier annoncé passe en A_TELECHARGER
// et le worker (telechargement.ts) s'en charge. Un fichier déjà reçu répond succès sans rien refaire,
// sinon PikCloud renverrait en boucle (§ 6).

// Nom de base sans extension ni séparateur de chemin (il ne sert jamais de chemin : le stockage utilise l'uuid)
const NOM_FICHIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

export const corpsWebhook = z
  .object({
    platform: z.literal("regie"),
    source: z.enum(["upload", "force"]),
    code_event: z.string().trim().min(1).max(8),
    borne: z.string().trim().min(1).max(64),
    type_media: z.string().trim().min(1).max(40),
    filename: z.string().regex(NOM_FICHIER, "nom de fichier invalide"),
    data_url: z.url().max(2000).optional(),
    media_url: z.url().max(2000).optional(),
    is_fake: z.boolean().optional(),
  })
  .refine((c) => c.data_url || c.media_url, { message: "data_url ou media_url requis" });

export type CorpsWebhook = z.infer<typeof corpsWebhook>;

/** Réponse du webhook : une entrée par fichier présent dans l'appel (§ 5). */
export interface ReponseWebhook {
  data?: EntreeReponse;
  photo?: EntreeReponse;
}

type TypeFichier = "data" | "photo";
const CHAMPS = {
  data: { url: "dataUrl", statut: "dataStatut" },
  photo: { url: "mediaUrl", statut: "mediaStatut" },
} as const;

type MajFichiers = Partial<Pick<Media, "dataUrl" | "dataStatut" | "mediaUrl" | "mediaStatut" | "nomFichier">>;

/** Nom du fichier à la fin d'un lien PikCloud (sans la query), ou null. */
export function nomFichierDuLien(url: string): string | null {
  try {
    const dernier = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return dernier.includes(".") ? dernier : null;
  } catch {
    return null;
  }
}

export async function recevoirMedia(corps: CorpsWebhook, ipSource: string | undefined): Promise<ReponseWebhook> {
  const [evenement, borne, existant] = await Promise.all([
    prisma.configEvenement.findUnique({ where: { code: corps.code_event }, select: { id: true, lieuId: true } }),
    prisma.borne.findUnique({ where: { identifiant: corps.borne }, select: { id: true } }),
    prisma.media.findUnique({ where: { codeEvent_filename: { codeEvent: corps.code_event, filename: corps.filename } } }),
  ]);

  // Chaque appel est un lot : payload brut conservé, erreurs dans la file (page Imports)
  const lot = await prisma.importLot.create({
    data: {
      source: "API",
      type: "MEDIAS",
      borneId: borne?.id,
      borneIdentifiant: corps.borne,
      payloadSha256: sha256Payload(corps),
      payload: corps as Prisma.InputJsonValue,
      ipSource,
      statut: "OK",
    },
  });

  const erreurs: { code: string; message: string }[] = [];
  if (!evenement && !existant?.configEvenementId) {
    erreurs.push({
      code: "EVENEMENT_INCONNU",
      message: `Code d'événement ${corps.code_event} inconnu : média ${corps.filename} (borne ${corps.borne}) stocké sans lieu`,
    });
  }

  const hotes = hotesAutorises();
  const reponse: ReponseWebhook = {};
  const maj: MajFichiers = {};
  let aTelecharger = false;
  let doublons = 0;

  for (const type of ["data", "photo"] as TypeFichier[]) {
    const url = type === "data" ? corps.data_url : corps.media_url;
    if (!url) continue;
    const hote = new URL(url).hostname.toLowerCase();
    if (!hotes.includes(hote)) {
      reponse[type] = echec("HOTE_INTERDIT", hote);
      erreurs.push({ code: "HOTE_INTERDIT", message: `${type} de ${corps.code_event}/${corps.filename} : hôte ${hote} refusé` });
      continue;
    }
    const champ = CHAMPS[type];
    const statut: FichierStatut = existant?.[champ.statut] ?? "ABSENT";
    if (statut === "TELECHARGE") {
      reponse[type] = succes("DEJA_RECU");
      doublons++;
    } else if (statut === "A_TELECHARGER") {
      // Déjà en file : on garde le lien le plus récent (un lien signé peut avoir expiré)
      maj[champ.url] = url;
      reponse[type] = succes("EN_ATTENTE");
      doublons++;
    } else {
      // ABSENT, ERREUR (un renvoi relance) ou PURGE (PikCloud l'a encore : on reprend une copie).
      // Lien qui répond déjà en erreur : 4002 tout de suite, PikCloud renverra (le worker ne le verrait qu'après le 200)
      const probleme = await verifierLien(url);
      if (probleme) {
        reponse[type] = echec("TELECHARGEMENT_IMPOSSIBLE", probleme);
        erreurs.push({ code: "TELECHARGEMENT_IMPOSSIBLE", message: `${type} de ${corps.code_event}/${corps.filename} : ${url} répond ${probleme}` });
        continue;
      }
      maj[champ.url] = url;
      maj[champ.statut] = "A_TELECHARGER";
      // Nom avec extension d'après le lien, en attendant le name_photo du JSON (qui prime)
      if (type === "photo" && !existant?.nomFichier) maj.nomFichier = nomFichierDuLien(url);
      aTelecharger = true;
      reponse[type] = succes();
    }
  }

  let cree = false;
  if (existant) {
    await prisma.media.update({
      where: { id: existant.id },
      data: {
        ...maj,
        ...(aTelecharger ? { tentatives: 0, derniereErreur: null } : {}),
        test: existant.test || (corps.is_fake ?? false),
        // Événement créé après l'arrivée du média : on rattache au passage
        configEvenementId: existant.configEvenementId ?? evenement?.id,
        lieuId: existant.lieuId ?? evenement?.lieuId,
        borneId: existant.borneId ?? borne?.id,
      },
    });
  } else {
    try {
      await prisma.media.create({
        data: {
          codeEvent: corps.code_event,
          filename: corps.filename,
          configEvenementId: evenement?.id,
          lieuId: evenement?.lieuId,
          borneId: borne?.id,
          borneIdentifiant: corps.borne,
          typeMedia: corps.type_media,
          importId: lot.id,
          test: corps.is_fake ?? false,
          ...maj,
        },
      });
      cree = true;
    } catch (e) {
      // Deux appels simultanés pour la même séance : le second repasse en mise à jour
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      await prisma.importLot.delete({ where: { id: lot.id } });
      return recevoirMedia(corps, ipSource);
    }
  }

  const fichiers = Object.keys(reponse).length;
  const rejetes = Object.values(reponse).filter((r) => !r.success).length;
  await prisma.importLot.update({
    where: { id: lot.id },
    data: {
      statut: erreurs.length ? "PARTIEL" : "OK",
      nbRecues: fichiers,
      nbCreees: cree ? 1 : 0,
      nbDoublons: doublons,
      nbRejetees: rejetes,
      erreurs: { create: erreurs },
    },
  });

  return reponse;
}
