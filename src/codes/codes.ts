import { randomInt } from "node:crypto";
import type { CodeRemise, LotCodesRemise } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { jourEtHeureLocaux } from "../lib/temps.js";

// Codes de remise (demande de Sébastien, 02/11/2026) : impressions offertes ou remise en %, saisis par l'invité
// sur la borne. La borne vérifie un code (verifier) puis l'utilise pour n impressions (utiliser).

/** 5 caractères, chiffres et majuscules sans les ambigus à l'écran de la borne (0/O, 1/I/L) */
export const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LONGUEUR = 5;

export function genererCode(tirer: (n: number) => number = randomInt): string {
  let c = "";
  for (let i = 0; i < LONGUEUR; i++) c += ALPHABET[tirer(ALPHABET.length)];
  return c;
}

/** Code tapé sur la borne : majuscules, sans espaces ni tirets */
export const normaliserCode = (saisi: string) => saisi.toUpperCase().replace(/[\s-]/g, "");

export type RaisonRefus = "INCONNU" | "DESACTIVE" | "EXPIRE" | "EPUISE" | "AUTRE_LIEU";

export const MESSAGES_REFUS: Record<RaisonRefus, string> = {
  INCONNU: "Code inconnu",
  DESACTIVE: "Code désactivé",
  EXPIRE: "Code expiré",
  EPUISE: "Code déjà entièrement utilisé",
  AUTRE_LIEU: "Code valable dans un autre lieu seulement",
};

type CodeAvecLot = CodeRemise & { lot: LotCodesRemise };

/**
 * État d'un code pour une borne : utilisable (et ce qu'il reste) ou refusé avec la raison.
 * lieuBorne : lieu où la borne est installée maintenant (null : en stock).
 */
export function etatCode(c: CodeAvecLot | null, lieuBorne: number | null, maintenant = new Date()): { valide: true; restant: number } | { valide: false; raison: RaisonRefus } {
  if (!c) return { valide: false, raison: "INCONNU" };
  if (c.desactiveLe) return { valide: false, raison: "DESACTIVE" };
  // Valable jusqu'au jour d'expiration inclus, heure de Paris
  if (jourEtHeureLocaux(maintenant).jour.getTime() > c.lot.expireLe.getTime()) return { valide: false, raison: "EXPIRE" };
  if (c.lot.seulementLieu && c.lot.lieuId !== null && c.lot.lieuId !== lieuBorne) return { valide: false, raison: "AUTRE_LIEU" };
  const restant = c.lot.quantite - c.utilise;
  if (restant <= 0) return { valide: false, raison: "EPUISE" };
  return { valide: true, restant };
}

/** Ce que la borne reçoit d'un code valable */
export const descriptionCode = (c: CodeAvecLot, restant: number) => ({
  code: c.code,
  type: c.lot.type === "OFFERT" ? ("offert" as const) : ("pourcentage" as const),
  pourcentage: c.lot.type === "POURCENTAGE" ? c.lot.pourcentage : null,
  quantite: c.lot.quantite,
  restant,
  expire_le: c.lot.expireLe.toISOString().slice(0, 10),
});

/** Lieu où la borne est installée maintenant */
export async function lieuActuel(borneId: number, maintenant = new Date()): Promise<number | null> {
  const a = await prisma.affectationBorne.findFirst({
    where: { borneId, debut: { lte: maintenant }, OR: [{ fin: null }, { fin: { gt: maintenant } }] },
    select: { lieuId: true },
  });
  return a?.lieuId ?? null;
}

export async function verifierCode(borneId: number, saisi: string) {
  const c = await prisma.codeRemise.findUnique({ where: { code: normaliserCode(saisi) }, include: { lot: true } });
  const e = etatCode(c, await lieuActuel(borneId));
  return e.valide ? { valide: true as const, ...descriptionCode(c!, e.restant) } : { valide: false as const, raison: e.raison, message: MESSAGES_REFUS[e.raison] };
}

/**
 * Utilise un code pour `demandees` impressions. S'il en reste moins, accorde ce qui reste et le dit.
 * Le code est verrouillé le temps du décompte (deux bornes en même temps ne dépassent pas la quantité) ;
 * un renvoi de la même utilisation (borne, utilisationId) renvoie le premier résultat sans décompter.
 */
export async function utiliserCode(borneId: number, saisi: string, demandees: number, utilisationId: string | null) {
  const lieuId = await lieuActuel(borneId);
  return prisma.$transaction(async (db) => {
    const [verrou] = await db.$queryRaw<{ id: number }[]>`SELECT id FROM codes_remise WHERE code = ${normaliserCode(saisi)} FOR UPDATE`;
    const c = verrou ? await db.codeRemise.findUnique({ where: { id: verrou.id }, include: { lot: true } }) : null;

    if (c && utilisationId) {
      const deja = await db.utilisationCodeRemise.findUnique({ where: { borneId_utilisationId: { borneId, utilisationId } } });
      if (deja) {
        const restant = Math.max(0, c.lot.quantite - c.utilise);
        return reponseUtilisation(deja.demandees, deja.accordees, restant, true);
      }
    }

    const e = etatCode(c, lieuId);
    if (!e.valide) return { ok: false, accordees: 0, demandees, restant: 0, raison: e.raison, message: MESSAGES_REFUS[e.raison] };

    const accordees = Math.min(e.restant, demandees);
    await db.codeRemise.update({ where: { id: c!.id }, data: { utilise: { increment: accordees } } });
    await db.utilisationCodeRemise.create({ data: { codeId: c!.id, borneId, lieuId, demandees, accordees, utilisationId } });
    return reponseUtilisation(demandees, accordees, e.restant - accordees, false);
  });
}

const reponseUtilisation = (demandees: number, accordees: number, restant: number, dejaEnregistree: boolean) => ({
  ok: accordees === demandees,
  accordees,
  demandees,
  restant,
  ...(dejaEnregistree ? { deja_enregistree: true } : {}),
  message:
    accordees === demandees
      ? `${accordees} impression${accordees > 1 ? "s" : ""} accordée${accordees > 1 ? "s" : ""}`
      : `Il ne restait que ${accordees} impression${accordees > 1 ? "s" : ""} sur ce code : ${accordees} accordée${accordees > 1 ? "s" : ""} sur ${demandees} demandée${demandees > 1 ? "s" : ""}`,
});

/** Crée n codes uniques pour un lot (nouveau tirage en cas de collision) */
export async function creerCodes(lotId: number, n: number, tirer: (n: number) => number = randomInt): Promise<number> {
  let crees = 0;
  for (let essai = 0; crees < n && essai < 10; essai++) {
    const lot = new Set<string>();
    while (lot.size < n - crees) lot.add(genererCode(tirer));
    const r = await prisma.codeRemise.createMany({ data: [...lot].map((code) => ({ code, lotId })), skipDuplicates: true });
    crees += r.count;
  }
  return crees;
}
