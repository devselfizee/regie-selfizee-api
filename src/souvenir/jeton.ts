import { createHmac, timingSafeEqual } from "node:crypto";
import { uuidCanonique } from "../synchro-pikcloud/json-seance.js";

// Jeton de la page souvenir (CDC § 3) : code d'événement + photo_uuid de la séance. Format retenu :
// `<CODE>-<photo_uuid en 32 hexadécimaux>` (RA7K-3f9a…). On accepte aussi le code collé à l'uuid, et
// l'uuid avec tirets ou en majuscules : c'est la borne qui écrit le lien du QR, autant ne pas dépendre
// d'un séparateur.

const CODE = /^[A-Z0-9]{3,8}$/;

export interface JetonSouvenir {
  code: string;
  /** photo_uuid canonique (avec tirets, minuscules), comme dans medias.photo_uuid */
  photoUuid: string;
}

/** « RA7K-3f9a… » (ou « RA7K3f9a… », uuid avec tirets) → code + photo_uuid ; null si ce n'est pas un jeton possible. */
export function lireJeton(brut: string): JetonSouvenir | null {
  const t = brut.trim();
  if (t.length > 60) return null;
  // L'uuid est à la fin : 36 caractères avec tirets, sinon 32 hexadécimaux
  for (const n of [36, 32]) {
    if (t.length <= n) continue;
    const photoUuid = uuidCanonique(t.slice(-n));
    if (!photoUuid || (n === 36 && t.slice(-n).split("-").length !== 5)) continue;
    const code = t.slice(0, -n).replace(/-$/, "").toUpperCase();
    if (CODE.test(code)) return { code, photoUuid };
  }
  return null;
}

/** Le jeton tel qu'on l'écrit : code, tiret, photo_uuid en 32 hexadécimaux minuscules. */
export const ecrireJeton = (code: string, photoUuid: string) => `${code.toUpperCase()}-${photoUuid.toLowerCase().replace(/-/g, "")}`;

// ─── URLs signées des fichiers ───
// Les visuels sont lus directement par le navigateur de l'invité : URL signée (HMAC du secret partagé avec la
// page souvenir) et expirante, jamais devinable ni listable (CDC § 3).

const secret = () => process.env.SOUVENIR_API_SECRET ?? "";

const signer = (chemin: string, expire: number) => createHmac("sha256", secret()).update(`${chemin}\n${expire}`).digest("base64url");

/** Paramètres `exp` et `sig` d'une URL valable `dureeS` secondes. */
export function signature(chemin: string, dureeS: number, maintenant = Date.now()): { exp: number; sig: string } {
  const exp = Math.floor(maintenant / 1000) + dureeS;
  return { exp, sig: signer(chemin, exp) };
}

export function signatureValide(chemin: string, exp: unknown, sig: unknown, maintenant = Date.now()): boolean {
  if (!secret() || typeof exp !== "string" || typeof sig !== "string" || !/^\d{1,12}$/.test(exp)) return false;
  const e = Number(exp);
  if (e * 1000 < maintenant) return false;
  const attendu = Buffer.from(signer(chemin, e));
  const recu = Buffer.from(sig);
  return attendu.length === recu.length && timingSafeEqual(attendu, recu);
}

// ─── Lien « Supprimer mes photos » (CDC § 9.3) ───
// Jeton propre à l'inscription, écrit dans le pied des mails : `<id de l'inscription>.<signature>`. Sans expiration
// (l'inscription est de toute façon effacée à 90 jours) ; la signature empêche de viser l'inscription d'un autre.

const signerOubli = (id: string) => createHmac("sha256", secret()).update(`oubli\n${id}`).digest("base64url");

export const jetonOubli = (inscriptionId: string) => `${inscriptionId}.${signerOubli(inscriptionId)}`;

/** L'id d'inscription d'un jeton « Supprimer mes photos » bien signé, sinon null. */
export function lireJetonOubli(brut: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(brut);
  if (!m || !secret()) return null;
  const attendu = Buffer.from(signerOubli(m[1]));
  const recu = Buffer.from(m[2]);
  return attendu.length === recu.length && timingSafeEqual(attendu, recu) ? m[1] : null;
}
