import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Jeton du lien d'accès aux données (plateforme RGPD, rgpd.orkessi.com/e/inf/<jeton>), valable 7 jours.
// Le booth écrivait l'adresse en triple base64 (lisible et fabricable par n'importe qui) ; ici l'adresse et la date
// sont chiffrées et authentifiées (AES-256-GCM) : le jeton ne révèle rien, et toute modification le rend invalide.
// Format : base64url( iv 12 octets | tag 16 octets | {"e":adresse,"t":secondes} chiffré ).

/** Durée de validité du lien d'accès. */
export const VALIDITE_JOURS = 7;
const VALIDITE_S = VALIDITE_JOURS * 24 * 3600;

/** Clé dérivée de RGPD_SECRET (à défaut, du secret de la page souvenir), séparée de ses autres usages. */
function cle(): Buffer | null {
  const secret = process.env.RGPD_SECRET || process.env.SOUVENIR_API_SECRET;
  return secret ? createHash("sha256").update(`rgpd-acces\n${secret}`).digest() : null;
}

/** Faux si aucun secret n'est configuré : les liens ne peuvent être ni écrits ni lus. */
export const jetonConfigure = () => cle() !== null;

export function ecrireJetonAcces(email: string, maintenant = Date.now()): string {
  const k = cle();
  if (!k) throw new Error("RGPD_SECRET absent");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const chiffre = Buffer.concat([c.update(JSON.stringify({ e: email, t: Math.floor(maintenant / 1000) }), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), chiffre]).toString("base64url");
}

export type LectureJeton = { email: string; expire: false } | { email: string; expire: true } | null;

/** L'adresse du jeton (expire : plus de 7 jours) ; null si le jeton est faux, falsifié ou illisible. */
export function lireJetonAcces(brut: unknown, maintenant = Date.now()): LectureJeton {
  const k = cle();
  if (!k || typeof brut !== "string" || brut.length < 40 || brut.length > 600 || !/^[A-Za-z0-9_-]+$/.test(brut)) return null;
  const b = Buffer.from(brut, "base64url");
  if (b.length < 29) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", k, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const clair = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as { e?: unknown; t?: unknown };
    if (typeof clair.e !== "string" || typeof clair.t !== "number") return null;
    return { email: clair.e, expire: maintenant / 1000 - clair.t >= VALIDITE_S };
  } catch {
    return null; // tag invalide : jeton falsifié ou d'un autre secret
  }
}
