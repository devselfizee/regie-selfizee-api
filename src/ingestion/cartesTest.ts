import { prisma } from "../lib/prisma.js";
import { recalculerAgregats } from "./agregats.js";

// Cartes de test (demande de Sébastien, 02/11/2026) : une vente payée avec une carte dont les 4 derniers
// chiffres sont dans cartes_test est marquée transactions.test. Elle reste stockée et visible à part,
// mais ne compte ni dans les agrégats (stats, tableau de bord, commissions) ni dans les exports.

/** 4 derniers chiffres des cartes de test, lus une fois par lot */
export async function chiffresCartesTest(): Promise<Set<string>> {
  return new Set((await prisma.carteTest.findMany({ select: { derniersChiffres: true } })).map((c) => c.derniersChiffres));
}

/**
 * Remet à jour le marquage des ventes payées avec ces chiffres (carte ajoutée, modifiée ou retirée),
 * et de leurs remboursements, puis reconstruit les agrégats des jours touchés. Renvoie le nombre de ventes changées.
 */
export async function appliquerCartesTest(chiffres: string[]): Promise<number> {
  if (!chiffres.length) return 0;
  const ventes = await prisma.$queryRaw<{ id: bigint; borne_id: number; jour_local: Date }[]>`
    UPDATE transactions t SET test = EXISTS (SELECT 1 FROM cartes_test c WHERE c.derniers_chiffres = t.carte_fin)
    WHERE t.carte_fin = ANY(${chiffres}::text[])
      AND t.test IS DISTINCT FROM EXISTS (SELECT 1 FROM cartes_test c WHERE c.derniers_chiffres = t.carte_fin)
    RETURNING t.id, t.borne_id, t.jour_local`;
  // Un remboursement saisi au back-office n'a pas de chiffres : il suit sa vente
  const remboursements = await prisma.$queryRaw<{ borne_id: number; jour_local: Date }[]>`
    UPDATE transactions r SET test = o.test FROM transactions o
    WHERE r.transaction_origine_id = o.id AND r.test <> o.test
    RETURNING r.borne_id, r.jour_local`;

  const parBorne = new Map<number, { min: number; max: number }>();
  for (const v of [...ventes, ...remboursements]) {
    const j = v.jour_local.getTime();
    const p = parBorne.get(v.borne_id);
    parBorne.set(v.borne_id, p ? { min: Math.min(p.min, j), max: Math.max(p.max, j) } : { min: j, max: j });
  }
  for (const [borneId, p] of parBorne) await recalculerAgregats(borneId, new Date(p.min), new Date(p.max));
  return ventes.length;
}
