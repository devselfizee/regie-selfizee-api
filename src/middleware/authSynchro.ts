import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { journaliserRejet } from "../ingestion/journal.js";

// Webhook de synchro PikCloud : secret partagé dans l'en-tête X-Synchro-Token (contrat § 2).
// Comparaison en temps constant ; 401 si absent ou faux ; 503 tant que le secret n'est pas configuré
// (PikCloud garde alors ses fichiers « en cours » et renverra, rien n'est perdu).

const EN_TETE = "x-synchro-token";

export const synchroConfiguree = () => Boolean(process.env.PIKCLOUD_SYNCHRO_SECRET);

function memeSecret(recu: string, attendu: string): boolean {
  const a = createHash("sha256").update(recu).digest();
  const b = createHash("sha256").update(attendu).digest();
  return timingSafeEqual(a, b);
}

export async function authSynchro(req: Request, res: Response, next: NextFunction) {
  try {
    const attendu = process.env.PIKCLOUD_SYNCHRO_SECRET;
    if (!attendu) {
      await journaliserRejet(req, "MEDIAS", "SYNCHRO_DESACTIVEE", "PIKCLOUD_SYNCHRO_SECRET non configuré");
      return res.status(503).json({ error: "SYNCHRO_DESACTIVEE" });
    }
    const recu = req.headers[EN_TETE];
    if (typeof recu !== "string" || !recu || !memeSecret(recu, attendu)) {
      await journaliserRejet(req, "MEDIAS", "TOKEN_INVALIDE", "En-tête X-Synchro-Token absent ou invalide");
      return res.status(401).json({ error: "TOKEN_INVALIDE" });
    }
    next();
  } catch (err) {
    next(err);
  }
}
