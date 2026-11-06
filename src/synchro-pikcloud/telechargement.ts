import { Readable } from "node:stream";
import type { ReadableStream as FluxWeb } from "node:stream/web";
import { Prisma, type Media } from "@prisma/client";
import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import { cheminAbsolu, ecrireBuffer, ecrireFlux, supprimer } from "../lib/stockage.js";
import { CODES_SYNCHRO } from "./codes.js";
import { JsonSeanceIllisible, lireJsonSeance } from "./json-seance.js";
import { hotesAutorises } from "./config.js";

// Worker de téléchargement des fichiers annoncés par PikCloud (contrat § 7) : lancé après chaque
// réception et toutes les minutes en rattrapage (taches.ts). Un fichier à la fois, en flux vers le
// stockage (vidéos jusqu'à 100 Mo), SHA-256 au passage, vignette pour les images. Après
// MEDIAS_TENTATIVES_MAX échecs, le fichier passe en ERREUR et apparaît dans la page Imports ;
// le renvoi suivant de PikCloud le remet en attente.

const MINUTE = 60_000;
const DELAI_HTTP = 120_000;
const JSON_MAX_OCTETS = 1024 * 1024;
const VIGNETTE_LARGEUR = 480;

export const tentativesMax = () => Number(process.env.MEDIAS_TENTATIVES_MAX) || 5;
const tailleMax = () => (Number(process.env.MEDIAS_TAILLE_MAX_MO) || 200) * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};
const IMAGES = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

export class LienInaccessible extends Error {}

/** Extension du fichier : celle du lien (contrat : .jpg, .gif, .mp4), sinon d'après le type MIME. */
export function extensionDe(url: string, contentType: string | null): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
  if (m) return m[1].toLowerCase();
  const mime = contentType?.split(";")[0].trim().toLowerCase();
  return (mime && EXTENSIONS[mime]) || "bin";
}

const hoteAutorise = (url: string) => hotesAutorises().includes(new URL(url).hostname.toLowerCase());

/** GET sur un lien PikCloud. L'hôte est revérifié, y compris après redirection. */
async function ouvrir(url: string): Promise<Response> {
  if (!hoteAutorise(url)) throw new LienInaccessible(`hôte de ${url} non autorisé`);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DELAI_HTTP) });
  } catch (e) {
    throw new LienInaccessible(e instanceof Error ? e.message : String(e));
  }
  if (res.url && res.url !== url && !hoteAutorise(res.url)) throw new LienInaccessible(`redirigé vers un hôte non autorisé`);
  if (!res.ok || !res.body) throw new LienInaccessible(`HTTP ${res.status}`);
  return res;
}

/**
 * Vérification rapide d'un lien à la réception (HEAD, 3 s) : un lien qui répond 404 ou 5xx vaut
 * un échec 4002 immédiat, pour que PikCloud sache qu'il doit renvoyer. Serveur lent (délai dépassé)
 * ou HEAD non supporté : on ne conclut rien, le worker tranchera.
 * Activée hors tests (PIKCLOUD_VERIFIER_LIENS=0 pour couper, =1 pour forcer).
 */
export async function verifierLien(url: string): Promise<string | null> {
  const reglage = process.env.PIKCLOUD_VERIFIER_LIENS;
  if (reglage === "0" || (reglage !== "1" && process.env.NODE_ENV === "test")) return null;
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    if (res.ok || res.status === 405 || res.status === 501) return null;
    return `HTTP ${res.status}`;
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") return null;
    return e instanceof Error ? e.message : String(e);
  }
}

async function traiterData(m: Media): Promise<void> {
  const res = await ouvrir(m.dataUrl!);
  if (Number(res.headers.get("content-length") ?? 0) > JSON_MAX_OCTETS) throw new JsonSeanceIllisible("fichier trop gros pour un JSON de séance");
  const texte = await res.text();
  if (texte.length > JSON_MAX_OCTETS) throw new JsonSeanceIllisible("fichier trop gros pour un JSON de séance");
  const c = lireJsonSeance(texte);
  await prisma.media.update({
    where: { id: m.id },
    data: {
      dataStatut: "TELECHARGE",
      photoUuid: c.photoUuid,
      datePhoto: c.datePhoto,
      dateSave: c.dateSave,
      datePrint: c.datePrint,
      nbTirages: c.nbTirages,
      test: m.test || c.testMode,
      ...(c.nomFichier ? { nomFichier: c.nomFichier } : {}),
      brut: c.brut as Prisma.InputJsonValue,
    },
  });
}

async function traiterMedia(m: Media): Promise<void> {
  const res = await ouvrir(m.mediaUrl!);
  const annonce = Number(res.headers.get("content-length") ?? 0);
  if (annonce > tailleMax()) throw new LienInaccessible(`fichier de ${annonce} octets, maximum ${tailleMax()}`);
  const ext = extensionDe(res.url || m.mediaUrl!, res.headers.get("content-type"));
  const dossier = m.uuid.slice(0, 2);
  const chemin = `${dossier}/${m.uuid}.${ext}`;
  const { taille, sha256 } = await ecrireFlux(chemin, Readable.fromWeb(res.body as FluxWeb), tailleMax());

  let vignette: string | null = null;
  if (IMAGES.has(ext)) {
    try {
      const image = await sharp(cheminAbsolu(chemin)).rotate().resize({ width: VIGNETTE_LARGEUR, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      vignette = `${dossier}/${m.uuid}.vignette.jpg`;
      await ecrireBuffer(vignette, image);
    } catch (e) {
      // Image illisible par sharp : le média est quand même conservé, sans vignette
      console.warn(`Vignette impossible pour le média ${m.uuid} :`, e instanceof Error ? e.message : e);
    }
  }
  await prisma.media.update({
    where: { id: m.id },
    data: { mediaStatut: "TELECHARGE", mediaChemin: chemin, vignetteChemin: vignette, tailleOctets: taille, sha256, telechargeLe: new Date() },
  });
}

async function enregistrerEchec(m: Media, type: "data" | "photo", e: unknown): Promise<void> {
  const code = e instanceof JsonSeanceIllisible ? "JSON_ILLISIBLE" : "TELECHARGEMENT_IMPOSSIBLE";
  const detail = e instanceof Error ? e.message : String(e);
  const message = `${CODES_SYNCHRO[code].message} : ${detail}`.slice(0, 500);
  const tentatives = m.tentatives + 1;
  const abandon = tentatives >= tentativesMax();
  await prisma.media.update({
    where: { id: m.id },
    data: { tentatives, derniereErreur: message, ...(abandon ? { [type === "data" ? "dataStatut" : "mediaStatut"]: "ERREUR" } : {}) },
  });
  if (abandon) {
    await prisma.importErreur.create({
      data: {
        importId: m.importId,
        code,
        message: `${type} de ${m.codeEvent}/${m.filename} (borne ${m.borneIdentifiant}) abandonné après ${tentatives} tentatives : ${message}`,
        payload: { uuid: m.uuid, url: type === "data" ? m.dataUrl : m.mediaUrl },
      },
    });
  }
}

export interface BilanTelechargement {
  traites: number;
  reussis: number;
  echoues: number;
}

let enCours = false;

/**
 * Une passe : les médias ayant un fichier en attente, les plus anciens d'abord. Après un échec, on
 * attend tentatives × 2 min avant de réessayer (ignorerDelai : pour les tests).
 */
export async function telechargerEnAttente(options: { limite?: number; ignorerDelai?: boolean } = {}): Promise<BilanTelechargement> {
  const bilan: BilanTelechargement = { traites: 0, reussis: 0, echoues: 0 };
  if (enCours) return bilan;
  enCours = true;
  try {
    const candidats = await prisma.media.findMany({
      where: { OR: [{ dataStatut: "A_TELECHARGER" }, { mediaStatut: "A_TELECHARGER" }] },
      orderBy: { updatedAt: "asc" },
      take: options.limite ?? 20,
    });
    const maintenant = Date.now();
    for (const candidat of candidats) {
      if (!options.ignorerDelai && candidat.tentatives > 0 && maintenant - candidat.updatedAt.getTime() < candidat.tentatives * 2 * MINUTE) continue;
      bilan.traites++;
      let m = candidat;
      if (m.dataStatut === "A_TELECHARGER" && m.dataUrl) {
        try {
          await traiterData(m);
          bilan.reussis++;
        } catch (e) {
          await enregistrerEchec(m, "data", e);
          bilan.echoues++;
        }
        m = await prisma.media.findUniqueOrThrow({ where: { id: m.id } });
      }
      if (m.mediaStatut === "A_TELECHARGER" && m.mediaUrl) {
        try {
          await traiterMedia(m);
          bilan.reussis++;
        } catch (e) {
          await enregistrerEchec(m, "photo", e);
          bilan.echoues++;
        }
      }
    }
  } finally {
    enCours = false;
  }
  return bilan;
}

let planifie = false;

/** Lance une passe en tâche de fond dès que possible (appelé après chaque réception). Coupé pendant les tests. */
export function declencherTelechargement(): void {
  if (process.env.NODE_ENV === "test" || process.env.MEDIAS_TELECHARGEMENT_AUTO === "0" || planifie) return;
  planifie = true;
  setImmediate(() => {
    planifie = false;
    telechargerEnAttente().catch((err) => console.error("Téléchargement des médias :", err));
  });
}

/**
 * Rétention (MEDIAS_RETENTION_JOURS, vide = pas de purge tant que Selfizee n'a pas fixé la durée) :
 * supprime le fichier et la vignette des médias plus anciens que la limite (date d'enregistrement sur
 * la borne, à défaut date de réception). La ligne reste, avec ses compteurs, en PURGE.
 */
export async function purgerMedias(maintenant = new Date()): Promise<number> {
  const jours = Number(process.env.MEDIAS_RETENTION_JOURS);
  if (!jours || jours <= 0) return 0;
  const limite = new Date(maintenant.getTime() - jours * 86_400_000);
  const perimes = await prisma.media.findMany({
    where: { mediaStatut: "TELECHARGE", OR: [{ dateSave: { lt: limite } }, { dateSave: null, createdAt: { lt: limite } }] },
    take: 500,
  });
  for (const m of perimes) {
    await supprimer(m.mediaChemin);
    await supprimer(m.vignetteChemin);
    await prisma.media.update({ where: { id: m.id }, data: { mediaStatut: "PURGE", mediaChemin: null, vignetteChemin: null } });
  }
  return perimes.length;
}
