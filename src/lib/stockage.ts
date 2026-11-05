import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

// Stockage des fichiers (médias des séances PikCloud) : un dossier local, MEDIAS_DIR (volume en prod).
// Tout passe par un chemin relatif à cette racine (jamais un nom venu de l'extérieur) : si l'équipe
// passe à un stockage objet (S3), seules ces fonctions changent, les chemins en base restent des clés.

export class FichierTropGros extends Error {
  constructor(public maxOctets: number) {
    super(`Fichier plus gros que ${maxOctets} octets`);
  }
}

/** Racine absolue du stockage (MEDIAS_DIR, défaut ./medias). */
export function racineStockage(): string {
  return resolve(process.env.MEDIAS_DIR || "./medias");
}

/** Chemin absolu d'un chemin relatif ; refuse toute sortie de la racine. */
export function cheminAbsolu(relatif: string): string {
  const racine = racineStockage();
  const absolu = normalize(join(racine, relatif));
  if (isAbsolute(relatif) || !absolu.startsWith(racine + sep)) throw new Error(`Chemin hors du stockage : ${relatif}`);
  return absolu;
}

/**
 * Écrit un flux dans le stockage : fichier temporaire puis renommage (jamais de fichier à moitié écrit).
 * Compte les octets et calcule le SHA-256 au passage ; au-delà de maxOctets, le flux est interrompu.
 */
export async function ecrireFlux(relatif: string, flux: Readable, maxOctets = Infinity): Promise<{ taille: number; sha256: string }> {
  const cible = cheminAbsolu(relatif);
  const temporaire = `${cible}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(resolve(cible, ".."), { recursive: true });
  const hash = createHash("sha256");
  let taille = 0;
  const compteur = new Transform({
    transform(morceau: Buffer, _enc, cb) {
      taille += morceau.length;
      if (taille > maxOctets) return cb(new FichierTropGros(maxOctets));
      hash.update(morceau);
      cb(null, morceau);
    },
  });
  try {
    await pipeline(flux, compteur, createWriteStream(temporaire));
    await rename(temporaire, cible);
  } catch (e) {
    await rm(temporaire, { force: true });
    throw e;
  }
  return { taille, sha256: hash.digest("hex") };
}

export async function ecrireBuffer(relatif: string, contenu: Buffer): Promise<void> {
  const cible = cheminAbsolu(relatif);
  await mkdir(resolve(cible, ".."), { recursive: true });
  const temporaire = `${cible}.tmp-${process.pid}-${Date.now()}`;
  await pipeline(Readable.from([contenu]), createWriteStream(temporaire));
  await rename(temporaire, cible);
}

export function lireFlux(relatif: string): Readable {
  return createReadStream(cheminAbsolu(relatif));
}

export async function existe(relatif: string): Promise<boolean> {
  return stat(cheminAbsolu(relatif)).then(() => true, () => false);
}

export async function supprimer(relatif: string | null | undefined): Promise<void> {
  if (relatif) await rm(cheminAbsolu(relatif), { force: true });
}
