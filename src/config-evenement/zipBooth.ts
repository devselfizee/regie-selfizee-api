import { createHash, randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { Prisma } from "@prisma/client";
import JSZip from "jszip";
import { HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { deplacer, ecrireBuffer, ecrireFlux, FichierTropGros, lireBuffer, supprimer } from "../lib/stockage.js";

// Événement booth « sur mesure » (avenant de l'équipe borne du 24/11/2026). Pour un événement créé dans booth puis
// retouché à la main (fonds, cadres, config.json), l'exploitant dépose le zip dans la Régie ; la Régie le sert aux
// bornes comme un de ses événements : programme (version ≥ 1 avec origine « booth »), statut, URL signée, reprise.
// L'événement reste un événement booth pour tout le reste (code, galerie, médias, codes promo).
// Décisions du 24/11/2026 : un zip par code booth (tous ses créneaux, tous lieux), 100 Mo au plus, config.json à la
// racine du zip. La version est le compteur des dépôts et ne redescend jamais : décocher « sur mesure » envoie
// version 0 à la borne (elle reprend booth), recocher ressert le dernier zip avec son numéro.
// Retour du 25/11 : un zip téléchargé de booth range tout dans un dossier au nom du code (« D229/config.json ») ; il est
// accepté tel quel et remis à la racine au dépôt, pour que la borne reçoive toujours le format des zips de la Régie.

/** Taille maximale d'un zip déposé (100 Mo) ; ZIP_BOOTH_MAX_OCTETS la change (tests). */
export const maxZipBooth = () => Number(process.env.ZIP_BOOTH_MAX_OCTETS) || 100 * 1024 * 1024;

/** Le zip déposé d'une version, dans le stockage (MEDIAS_DIR) : à part des zips Régie, un code booth peut commencer par R. */
export const cheminZipBooth = (code: string, version: number) => `evenements-booth/${code}/v${version}.zip`;

/** Ce qu'il faut d'un zip booth pour le programme et le statut (même forme que l'événement Régie pour etatDuZip). */
export const selectionZipBooth = { code: true, version: true, actif: true, publieeLe: true, zipChemin: true, zipTaille: true, zipSha256: true } as const;
export type ZipBoothServi = { code: string; version: number; actif: boolean; publieeLe: Date | null; zipChemin: string | null; zipTaille: number | null; zipSha256: string | null };

/** Version annoncée à la borne : celle du dernier dépôt si la case « sur mesure » est cochée, sinon 0 (booth). */
export const versionServie = (z: Pick<ZipBoothServi, "actif" | "version"> | null | undefined) => (z?.actif && z.version > 0 ? z.version : 0);

/** Les zips booth de ces codes, par code. */
export async function zipsBoothDe(codes: string[]): Promise<Map<string, ZipBoothServi>> {
  if (!codes.length) return new Map();
  const zips = await prisma.zipBooth.findMany({ where: { code: { in: [...new Set(codes)] } }, select: selectionZipBooth });
  return new Map(zips.map((z) => [z.code, z]));
}

/**
 * Le zip servi pour ce code à une borne de ce lieu : seulement si le code est programmé sur le lieu (même règle
 * d'accès qu'un événement Régie) et si la case « sur mesure » est cochée ; null sinon (la borne prend booth).
 */
export async function zipBoothPourLieu(code: string, lieuId: number): Promise<ZipBoothServi | null> {
  const creneau = await prisma.evenementBooth.findFirst({ where: { code, lieuId }, select: { id: true } });
  if (!creneau) return null;
  const z = await prisma.zipBooth.findUnique({ where: { code }, select: selectionZipBooth });
  return z && versionServie(z) > 0 ? z : null;
}

/** Fichiers ajoutés par macOS (« Compresser ») : ignorés, et retirés d'un zip remis à la racine. */
const ENTREE_SYSTEME = /(^|\/)(__MACOSX\/|\.DS_Store$)/;

/** Le zip déposé, lu : son code d'événement, et le dossier unique qui le contient (zip de booth) ou null (racine). */
export interface ZipLu {
  code: string;
  dossier: string | null;
  archive: JSZip;
}

/**
 * Lit le zip déposé : le code d'événement de son config.json (`event.code`, comme les config.json de booth et de la
 * Régie), en majuscules. Le config.json est attendu à la racine, comme dans les zips de la Régie, ou dans un dossier
 * unique qui contient tout, comme les zips téléchargés de booth (« D229/config.json ») : remettreALaRacine le remet
 * alors à la racine. Refus explicite (400) d'un fichier qui n'est pas un zip, sans config.json à l'un de ces endroits,
 * ou dont le config.json est illisible ou sans code : la borne le refuserait de toute façon.
 */
export async function lireZipDepose(zip: Buffer): Promise<ZipLu> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(zip);
  } catch {
    throw new HttpError(400, "ZIP_ILLISIBLE", "Ce fichier n'est pas un zip lisible.");
  }
  let dossier: string | null = null;
  let config = archive.file("config.json");
  if (!config) {
    const entrees = Object.keys(archive.files).filter((n) => !ENTREE_SYSTEME.test(n));
    const premiers = new Set(entrees.map((n) => n.split("/")[0]));
    const [seul] = premiers;
    const dansUnDossier = premiers.size === 1 && entrees.every((n) => n.startsWith(`${seul}/`)) ? archive.file(`${seul}/config.json`) : null;
    if (!dansUnDossier) {
      const ailleurs = archive.file(/(^|\/)config\.json$/i).find((f) => !ENTREE_SYSTEME.test(f.name));
      throw new HttpError(
        400,
        "CONFIG_ABSENT",
        ailleurs
          ? `Le config.json est dans « ${ailleurs.name.replace(/config\.json$/i, "")} » : il doit être à la racine du zip, ou dans un seul dossier qui contient tout (comme les zips de booth).`
          : "Le zip ne contient pas de config.json."
      );
    }
    dossier = `${seul}/`;
    config = dansUnDossier;
  }
  let contenu: unknown;
  try {
    // trimStart retire aussi l'indicateur d'ordre des octets (BOM) d'un fichier enregistré sous Windows
    contenu = JSON.parse((await config.async("string")).trimStart());
  } catch {
    throw new HttpError(400, "CONFIG_ILLISIBLE", "Le config.json du zip n'est pas un JSON valide.");
  }
  const code = (contenu as { event?: { code?: unknown } } | null)?.event?.code;
  if (typeof code !== "string" || !code.trim()) throw new HttpError(400, "CODE_ABSENT", "Le config.json du zip ne porte pas de code d'événement (event.code).");
  return { code: code.trim().toUpperCase(), dossier, archive };
}

/** Le zip refait avec le contenu du dossier à la racine (dossiers vides gardés, fichiers macOS retirés). */
export async function remettreALaRacine(archive: JSZip, dossier: string): Promise<Buffer> {
  const sortie = new JSZip();
  for (const f of Object.values(archive.files)) {
    if (ENTREE_SYSTEME.test(f.name) || !f.name.startsWith(dossier) || f.name === dossier) continue;
    const nom = f.name.slice(dossier.length);
    if (f.dir) sortie.folder(nom);
    else sortie.file(nom, await f.async("nodebuffer"), { date: f.date });
  }
  return sortie.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export interface DepotZipBooth {
  code: string;
  /** Nom du fichier envoyé, pour s'y retrouver dans la Régie */
  nomFichier: string | null;
  deposeParId: number | null;
  /** D'où vient le dépôt (journal d'audit) */
  lieuId: number;
  creneauId: number;
}

/**
 * Dépôt d'un zip : écrit en flux dans un fichier d'attente (100 Mo au plus, empreinte SHA-256 au passage), contrôle
 * le code du config.json, puis enregistre la version suivante (case cochée) et range le fichier à son nom définitif.
 * Si un contrôle échoue, rien n'a changé : le fichier d'attente est supprimé. Rend la version enregistrée.
 */
export async function deposerZipBooth(flux: Readable, d: DepotZipBooth): Promise<number> {
  const max = maxZipBooth();
  const attente = `evenements-booth/${d.code}/depot-${randomBytes(6).toString("hex")}.zip`;
  let empreinte: { taille: number; sha256: string };
  try {
    empreinte = await ecrireFlux(attente, flux, max);
  } catch (e) {
    if (e instanceof FichierTropGros) throw new HttpError(413, "ZIP_TROP_GROS", `Le zip dépasse ${Math.round(max / 1024 / 1024)} Mo.`);
    throw e;
  }
  try {
    if (empreinte.taille === 0) throw new HttpError(400, "ZIP_VIDE", "Aucun fichier reçu.");
    const lu = await lireZipDepose(await lireBuffer(attente));
    const code = lu.code;
    if (code !== d.code) {
      throw new HttpError(400, "CODE_DIFFERENT", `Le config.json de ce zip porte le code ${code}, pas ${d.code} : la borne le refuserait. Vérifiez le zip ou le code du créneau.`);
    }
    // Zip de booth (tout dans un dossier) : rangé avec son contenu à la racine, empreinte et taille recalculées
    if (lu.dossier) {
      const refait = await remettreALaRacine(lu.archive, lu.dossier);
      await ecrireBuffer(attente, refait);
      empreinte = { taille: refait.length, sha256: createHash("sha256").update(refait).digest("hex") };
    }
    const maintenant = new Date();
    const version = await prisma.$transaction(async (db) => {
      const avant = await db.zipBooth.findUnique({ where: { code: d.code }, select: { id: true, version: true } });
      const version = (avant?.version ?? 0) + 1;
      const data = {
        version, actif: true, publieeLe: maintenant, zipChemin: cheminZipBooth(d.code, version), zipTaille: empreinte.taille, zipSha256: empreinte.sha256,
        nomFichier: d.nomFichier, deposeParId: d.deposeParId,
      };
      // Seulement si personne n'a déposé entre-temps : la version doit être celle du fichier rangé
      if (avant) {
        const maj = await db.zipBooth.updateMany({ where: { id: avant.id, version: avant.version }, data });
        if (!maj.count) throw new HttpError(409, "DEPOT_CONCURRENT", "Un autre zip vient d'être déposé pour ce code : rechargez la page.");
      } else {
        await db.zipBooth.create({ data: { code: d.code, ...data } });
      }
      await db.auditLog.create({
        data: {
          userId: d.deposeParId, entite: "zip_booth", entiteId: d.code, action: "DEPOT",
          apres: { code: d.code, version, taille: empreinte.taille, sha256: empreinte.sha256, nomFichier: d.nomFichier, lieuId: d.lieuId, creneauId: d.creneauId },
        },
      });
      return version;
    }).catch((e) => {
      // Premier dépôt de ce code en même temps qu'un autre
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new HttpError(409, "DEPOT_CONCURRENT", "Un autre zip vient d'être déposé pour ce code : rechargez la page.");
      throw e;
    });
    // Renommé après l'enregistrement de la version ; l'avant-dernière reste, pour une borne en plein téléchargement
    await deplacer(attente, cheminZipBooth(d.code, version));
    if (version > 2) await supprimer(cheminZipBooth(d.code, version - 2)).catch(() => undefined);
    return version;
  } catch (e) {
    await supprimer(attente).catch(() => undefined);
    throw e;
  }
}
