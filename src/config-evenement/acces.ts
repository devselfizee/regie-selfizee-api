import type { Request } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import { genererCodeEvenement, genererMotDePasse, type Reglages } from "./reglages.js";

// Événements de la borne d'un lieu : l'habituel (/api/lieux/:id/evenement) et les ponctuels
// (/api/lieux/:id/evenements-ponctuels/:eid : Halloween, une soirée…). Mêmes routes pour les deux.

/** Les deux chemins d'une route de la fiche événement, habituel puis ponctuel. */
export const chemins = (suite = "") => [`/:id/evenement${suite}`, `/:id/evenements-ponctuels/:eid${suite}`];

/** Lieu et événement visés par la requête ; `eid` null = l'événement habituel du lieu. */
export function cible(req: Request): { lieuId: number; eid: number | null } {
  const lieuId = Number(req.params.id);
  const eid = req.params.eid === undefined ? null : Number(req.params.eid);
  if (!Number.isInteger(lieuId) || (eid !== null && !Number.isInteger(eid))) throw new HttpError(404, "INTROUVABLE");
  return { lieuId, eid };
}

/** L'événement visé : l'habituel peut ne pas exister encore (null), un ponctuel inconnu est une 404. */
export async function evenementDe(lieuId: number, eid: number | null) {
  if (eid === null) return prisma.configEvenement.findFirst({ where: { lieuId, habituel: true } });
  const e = await prisma.configEvenement.findFirst({ where: { id: eid, lieuId, habituel: false } });
  if (!e) throw new HttpError(404, "INTROUVABLE", "Événement introuvable");
  return e;
}

/** Crée un événement avec un code R… tiré au hasard ; nouvel essai en cas de collision (31³ ≈ 30 000 codes). */
export async function creerEvenement(data: { lieuId: number; habituel: boolean; nom: string | null; reglages: Reglages }) {
  for (let essai = 0; ; essai++) {
    try {
      return await prisma.configEvenement.create({ data: { ...data, code: genererCodeEvenement(), motDePasseTableau: genererMotDePasse() } });
    } catch (e) {
      const collision = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && String(e.meta?.target).includes("code");
      if (!collision || essai >= 20) throw e;
    }
  }
}

/** Le config.json change avec les cadres : l'événement passe « modifié depuis la publication ». */
export const toucher = (evenementId: number) => prisma.configEvenement.update({ where: { id: evenementId }, data: { updatedAt: new Date() } });
