import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Borne } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ecrireBuffer, existe, supprimer } from "../lib/stockage.js";

// Zip de l'événement chargé par la borne, sur le modèle du booth (getEvent puis e/zip/download/<paramètre>) :
// 1. la borne demande l'état de son événement avec sa clé (POST /ingest/v1/evenements/statut) ;
// 2. elle reçoit une URL de téléchargement signée et courte (GET /ingest/v1/evenements/<code>/zip?v=&exp=&sig=).
// Différences avec le booth : la demande est authentifiée (clé de la borne, et la borne doit être installée dans le
// lieu de l'événement) ; l'URL est signée (HMAC) et expire, au lieu d'un paramètre en base64 que tout le monde peut
// fabriquer ; le zip est figé à la publication (le contenu ne bouge pas entre deux publications).

/** Durée de validité de l'URL de téléchargement. */
const VALIDITE_URL_S = 15 * 60;

/** Le zip publié d'une version, dans le stockage (MEDIAS_DIR). */
export const cheminZip = (code: string, version: number) => `evenements/${code}/v${version}.zip`;

/** Ce que la base retient du zip d'une publication (le fichier est rangé ensuite, par rangerZip). */
export const empreinteZip = (code: string, version: number, zip: Buffer) => ({
  zipChemin: cheminZip(code, version),
  zipTaille: zip.length,
  zipSha256: createHash("sha256").update(zip).digest("hex"),
});

/**
 * Range le zip d'une publication, une fois la version enregistrée, et retire celui d'avant l'avant-dernière (la
 * version précédente reste un temps, pour une borne en plein téléchargement).
 */
export async function rangerZip(code: string, version: number, zip: Buffer) {
  await ecrireBuffer(cheminZip(code, version), zip);
  if (version > 2) await supprimer(cheminZip(code, version - 2)).catch(() => undefined);
}

// ─── URL signée ───
// Secret BORNE_ZIP_SECRET ; à défaut, un secret tiré au démarrage (une seule instance d'API : les URLs ne
// survivent pas à un redémarrage, la borne redemande l'état).

const secretDuProcessus = randomBytes(32);
const secret = () => process.env.BORNE_ZIP_SECRET || secretDuProcessus;
const signer = (code: string, version: number, exp: number) => createHmac("sha256", secret()).update(`zip-borne\n${code}\n${version}\n${exp}`).digest("base64url");

export function urlZip(base: string, code: string, version: number, maintenant = Date.now()) {
  const exp = Math.floor(maintenant / 1000) + VALIDITE_URL_S;
  return { url: `${base}/ingest/v1/evenements/${encodeURIComponent(code)}/zip?v=${version}&exp=${exp}&sig=${signer(code, version, exp)}`, expireLe: new Date(exp * 1000) };
}

export function urlZipValide(code: string, version: unknown, exp: unknown, sig: unknown, maintenant = Date.now()): number | null {
  if (typeof version !== "string" || !/^\d{1,6}$/.test(version) || typeof exp !== "string" || !/^\d{1,12}$/.test(exp) || typeof sig !== "string") return null;
  if (Number(exp) * 1000 < maintenant) return null;
  const attendu = Buffer.from(signer(code, Number(version), Number(exp)));
  const recu = Buffer.from(sig);
  return attendu.length === recu.length && timingSafeEqual(attendu, recu) ? Number(version) : null;
}

// ─── État de l'événement pour la borne ───

export type StatutZip =
  | { status: "unknown" }
  | { status: "incomplete" }
  | { status: "obsolete"; version: number; message: string }
  | { status: "complete"; code: string; version: number; publieLe: string; taille: number; sha256: string; url: string; expireLe: string };

/** Lieu où la borne est installée aujourd'hui (affectation en cours), ou null. */
export async function lieuDeLaBorne(borneId: number, maintenant: Date): Promise<number | null> {
  const a = await prisma.affectationBorne.findFirst({
    where: { borneId, debut: { lte: maintenant }, OR: [{ fin: null }, { fin: { gt: maintenant } }] },
    orderBy: { debut: "desc" },
    select: { lieuId: true },
  });
  return a?.lieuId ?? null;
}

/**
 * État du zip d'un événement, comme getEvent du booth : « unknown » (code inconnu, ou événement d'un autre lieu que
 * celui de la borne), « incomplete » (jamais publié), « obsolete » (publié avant que la Régie fige les zips :
 * republier), « complete » avec l'URL de téléchargement.
 */
/** Ce qu'il faut d'un événement pour connaître l'état de son zip. */
export const selectionZip = { code: true, lieuId: true, version: true, publieeLe: true, zipChemin: true, zipTaille: true, zipSha256: true } as const;
type EvenementZip = { code: string; version: number; publieeLe: Date | null; zipChemin: string | null; zipTaille: number | null; zipSha256: string | null };

/** État du zip publié : incomplete (jamais publié), obsolete (zip absent : republier), complete. */
export async function etatDuZip(e: EvenementZip): Promise<"incomplete" | "obsolete" | "complete"> {
  if (!e.publieeLe || e.version === 0) return "incomplete";
  if (!e.zipChemin || !e.zipTaille || !e.zipSha256 || !(await existe(e.zipChemin))) return "obsolete";
  return "complete";
}

export async function statutPourBorne(borne: Pick<Borne, "id">, code: string, base: string, maintenant = new Date()): Promise<StatutZip> {
  const e = await prisma.configEvenement.findUnique({ where: { code }, select: selectionZip });
  if (!e || e.lieuId !== (await lieuDeLaBorne(borne.id, maintenant))) return { status: "unknown" };
  const etat = await etatDuZip(e);
  if (etat === "incomplete") return { status: "incomplete" };
  if (etat === "obsolete") return { status: "obsolete", version: e.version, message: "Republier l'événement dans la Régie pour préparer son zip." };
  const { url, expireLe } = urlZip(base, e.code, e.version, maintenant.getTime());
  return {
    status: "complete",
    code: e.code,
    version: e.version,
    publieLe: e.publieeLe!.toISOString(),
    taille: e.zipTaille!,
    sha256: e.zipSha256!,
    url,
    expireLe: expireLe.toISOString(),
  };
}
