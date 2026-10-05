import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

/** Route async : toute erreur est transmise au gestionnaire d'erreurs central. */
export const asynchrone =
  <R extends Request>(fn: (req: R, res: Response) => Promise<unknown>) =>
  (req: R, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/** Convertit les erreurs connues (validation, Prisma, contraintes SQL) en réponses HTTP. */
export function reponseErreur(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.code, message: err.message } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: "VALIDATION",
        champs: err.issues.map((i) => ({ chemin: i.path.join("."), message: i.message })),
      },
    };
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") return { status: 404, body: { error: "INTROUVABLE" } };
    if (err.code === "P2002") return { status: 409, body: { error: "DEJA_EXISTANT", champs: err.meta?.target } };
    if (err.code === "P2003") return { status: 409, body: { error: "REFERENCE_INVALIDE", champ: err.meta?.field_name } };
  }
  // Contrainte d'exclusion PostgreSQL (chevauchement d'affectations ou de contrats)
  const message = err instanceof Error ? err.message : "";
  if (message.includes("23P01") || message.includes("pas_de_chevauchement")) {
    return { status: 409, body: { error: "CHEVAUCHEMENT", message: "Cette période chevauche une période existante" } };
  }
  return null;
}
