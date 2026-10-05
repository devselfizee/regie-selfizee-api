import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Format : rgs_<préfixe 8 car.>_<secret 43 car.>
// Le préfixe identifie la borne sans lire le secret ; seul le hash du secret est stocké.
// Le secret fait 256 bits aléatoires : un SHA-256 suffit (pas besoin de bcrypt).
const FORMAT = /^rgs_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export interface CleGeneree {
  cle: string; // à transmettre une seule fois au technicien
  prefixe: string;
  hash: string;
}

export function genererCle(): CleGeneree {
  const prefixe = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "0").slice(0, 8);
  const secret = randomBytes(32).toString("base64url");
  return { cle: `rgs_${prefixe}_${secret}`, prefixe, hash: hacher(secret) };
}

export function decouperCle(cle: string): { prefixe: string; secret: string } | null {
  const m = FORMAT.exec(cle);
  return m ? { prefixe: m[1], secret: m[2] } : null;
}

export function verifierSecret(secret: string, hashAttendu: string): boolean {
  const a = Buffer.from(hacher(secret), "hex");
  const b = Buffer.from(hashAttendu, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function hacher(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
