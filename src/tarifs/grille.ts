import { z } from "zod";
import { prisma } from "../lib/prisma.js";

// Grille de prix des tirages, sur trois niveaux (demande de Sébastien, 28/10/2026) :
// tarifs de base du parc Selfizee → tarifs par défaut d'un lieu (s'il en a) → tarifs d'un événement
// (s'il ne reprend pas ceux du lieu). Montants en centimes.

export const grilleSchema = z.object({
  // Grille dégressive : le premier palier (à partir de 1 tirage) est le prix unitaire
  paliers: z.array(z.object({ de: z.number().int().min(1).max(50), prixCents: z.number().int().min(0).max(100_00) })).min(1).max(10),
  palierMisEnAvant: z.number().int().min(1).max(50).nullable(),
  libelleMisEnAvant: z.string().trim().max(200).default("Le plus populaire"),
  // « +1 pour un pote » pendant l'impression ; 0 = question masquée
  plusUnCents: z.number().int().min(0).max(100_00),
});
export type Grille = z.infer<typeof grilleSchema>;

/** Grille d'usine (mode régie, CDC § 13.3), tant qu'aucun tarif de base n'est saisi. */
export const GRILLE_DEFAUT: Grille = {
  paliers: [
    { de: 1, prixCents: 350 },
    { de: 2, prixCents: 300 },
    { de: 3, prixCents: 250 },
  ],
  palierMisEnAvant: 2,
  libelleMisEnAvant: "Le plus populaire",
  plusUnCents: 200,
};

/** Erreurs bloquantes d'une grille (paliers croissants et dégressifs). */
export function erreursGrille(g: Grille): string[] {
  const e: string[] = [];
  const p = g.paliers;
  if (p[0]?.de !== 1) e.push("Le premier palier de prix doit commencer à 1 tirage.");
  for (let i = 1; i < p.length; i++) {
    if (p[i].de <= p[i - 1].de) e.push("Les paliers doivent aller dans l'ordre croissant des quantités.");
    if (p[i].prixCents > p[i - 1].prixCents) e.push("La grille doit être dégressive : un palier coûte plus cher que le précédent.");
  }
  if (g.palierMisEnAvant !== null && !p.some((x) => x.de === g.palierMisEnAvant)) e.push("Le palier mis en avant n'existe pas dans la grille.");
  return [...new Set(e)];
}

export type OrigineGrille = "LIEU" | "BASE" | "DEFAUT";

/** Tarifs de base du parc (null : pas encore saisis, la grille d'usine s'applique). */
export async function grilleBase(): Promise<Grille | null> {
  const g = await prisma.grilleTarifs.findFirst({ where: { lieuId: null } });
  return g ? grilleSchema.parse(g.grille) : null;
}

/** Tarifs propres au lieu (null : il reprend les tarifs de base). */
export async function grilleLieu(lieuId: number): Promise<Grille | null> {
  const g = await prisma.grilleTarifs.findUnique({ where: { lieuId } });
  return g ? grilleSchema.parse(g.grille) : null;
}

/** Tarifs par défaut d'un lieu : les siens, sinon ceux de base, sinon la grille d'usine. */
export async function grilleEffective(lieuId: number): Promise<{ grille: Grille; origine: OrigineGrille }> {
  const [lieu, base] = await Promise.all([grilleLieu(lieuId), grilleBase()]);
  if (lieu) return { grille: lieu, origine: "LIEU" };
  if (base) return { grille: base, origine: "BASE" };
  return { grille: GRILLE_DEFAUT, origine: "DEFAUT" };
}
