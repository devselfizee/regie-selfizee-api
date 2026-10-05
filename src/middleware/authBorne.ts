import type { NextFunction, Request, Response } from "express";
import type { Borne, ImportType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decouperCle, verifierSecret } from "../lib/cleBorne.js";
import { journaliserRejet } from "../ingestion/journal.js";

export interface BorneRequest extends Request {
  borne?: Borne;
}

/**
 * Authentifie une borne par sa clé propre (Authorization: Bearer rgs_…).
 * Le borne_id du payload doit être celui de la borne authentifiée.
 */
export function authBorne(type: ImportType) {
  return async (req: BorneRequest, res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization ?? "";
      const parts = header.startsWith("Bearer ") ? decouperCle(header.slice(7).trim()) : null;

      const borne = parts
        ? await prisma.borne.findUnique({ where: { apiKeyPrefix: parts.prefixe } })
        : null;

      if (!parts || !borne?.apiKeyHash || !verifierSecret(parts.secret, borne.apiKeyHash)) {
        await journaliserRejet(req, type, "CLE_INVALIDE", "Clé borne absente ou invalide");
        return res.status(401).json({ error: "CLE_INVALIDE" });
      }

      if (req.body?.borne_id !== borne.identifiant) {
        await journaliserRejet(
          req,
          type,
          "BORNE_DIFFERENTE",
          `borne_id "${req.body?.borne_id}" ne correspond pas à la clé (${borne.identifiant})`,
          borne.id
        );
        return res.status(403).json({ error: "BORNE_DIFFERENTE" });
      }

      if (borne.statut === "REFORMEE") {
        await journaliserRejet(req, type, "BORNE_REFORMEE", "Borne réformée", borne.id);
        return res.status(403).json({ error: "BORNE_REFORMEE" });
      }

      req.borne = borne;
      next();
    } catch (err) {
      next(err);
    }
  };
}
