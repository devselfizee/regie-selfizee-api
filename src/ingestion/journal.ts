import { createHash } from "node:crypto";
import { Prisma, type ImportType } from "@prisma/client";
import type { Request } from "express";
import { prisma } from "../lib/prisma.js";

export function sha256Payload(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

/** Lot rejeté en entier (clé invalide, JSON non conforme…) : tracé dans la file d'erreurs. */
export async function journaliserRejet(
  req: Request,
  type: ImportType,
  code: string,
  message: string,
  borneId?: number
) {
  const body = req.body ?? null;
  const borneIdentifiant =
    typeof body?.borne_id === "string" ? body.borne_id.slice(0, 64) : null;

  return prisma.importLot.create({
    data: {
      source: "API",
      type,
      borneId,
      borneIdentifiant,
      schemaVersion: typeof body?.schema_version === "string" ? body.schema_version : null,
      payloadSha256: sha256Payload(body),
      payload: body ?? Prisma.JsonNull,
      ipSource: req.ip,
      statut: "REJETE",
      erreurs: { create: { code, message } },
    },
  });
}
