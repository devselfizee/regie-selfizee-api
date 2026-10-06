// Rentabilité nette par borne et retour sur investissement (CDC §5.3).
// Marge nette = CA HT − commissions (part de la borne) − coûts saisis − amortissement.
import { prisma } from "../lib/prisma.js";

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const jours = (du: Date, au: Date) => Math.max(0, Math.round((au.getTime() - du.getTime()) / JOUR) + 1);
const max = (a: Date, b: Date) => (a > b ? a : b);
const min = (a: Date, b: Date) => (a < b ? a : b);

/** Fin d'amortissement : date de mise en service + durée (mois), exclue. */
export function finAmortissement(miseEnService: Date, dureeMois: number): Date {
  const d = new Date(miseEnService);
  d.setUTCMonth(d.getUTCMonth() + dureeMois);
  return d;
}

/** Amortissement linéaire au jour, sur la partie de [du, au] comprise dans la durée d'amortissement. */
export function amortissement(
  b: { coutAchatCents: number | null; dureeAmortissementMois: number | null; dateMiseEnService: Date | null },
  du: Date,
  au: Date
): number {
  if (!b.coutAchatCents || !b.dureeAmortissementMois || !b.dateMiseEnService) return 0;
  const fin = new Date(finAmortissement(b.dateMiseEnService, b.dureeAmortissementMois).getTime() - JOUR);
  const total = jours(b.dateMiseEnService, fin);
  const couverts = jours(max(du, b.dateMiseEnService), min(au, fin));
  return total ? (b.coutAchatCents * couverts) / total : 0;
}

async function caBorne(borneId: number, du: Date, au: Date) {
  const r = await prisma.aggJour.aggregate({
    where: { borneId, jour: { gte: du, lte: au } },
    _sum: { caTtcCents: true, caHtCents: true, rembourseHtCents: true, nbAcceptees: true },
  });
  return {
    caTtcCents: r._sum.caTtcCents ?? 0,
    caHtCents: (r._sum.caHtCents ?? 0) - (r._sum.rembourseHtCents ?? 0),
    nbVentes: r._sum.nbAcceptees ?? 0,
  };
}

/**
 * Commissions attribuables à la borne sur [du, au] : pour chaque reversement calculé qui
 * chevauche la période, la part de la borne (son CA dans le lieu ÷ CA du lieu), au prorata
 * des jours communs. Les périodes pas encore calculées n'ont pas de commission.
 */
async function commissionsBorne(borneId: number, du: Date, au: Date) {
  const lieux = await prisma.aggJour.findMany({ where: { borneId, jour: { gte: du, lte: au } }, distinct: ["lieuId"], select: { lieuId: true } });
  const reversements = await prisma.reversement.findMany({
    where: { lieuId: { in: lieux.map((l) => l.lieuId) }, periodeDebut: { lte: au }, periodeFin: { gte: du } },
  });
  let total = 0;
  for (const r of reversements) {
    const [part, tout] = await Promise.all([
      prisma.aggJour.aggregate({ where: { borneId, lieuId: r.lieuId, jour: { gte: r.periodeDebut, lte: r.periodeFin } }, _sum: { caTtcCents: true } }),
      prisma.aggJour.aggregate({ where: { lieuId: r.lieuId, jour: { gte: r.periodeDebut, lte: r.periodeFin } }, _sum: { caTtcCents: true } }),
    ]);
    const lieuCa = tout._sum.caTtcCents ?? 0;
    if (!lieuCa) continue;
    const prorata = jours(max(du, r.periodeDebut), min(au, r.periodeFin)) / jours(r.periodeDebut, r.periodeFin);
    total += r.montantAReverserCents * ((part._sum.caTtcCents ?? 0) / lieuCa) * prorata;
  }
  return Math.round(total);
}

async function coutsBorne(borneId: number, du: Date, au: Date) {
  const lignes = await prisma.coutBorne.groupBy({
    by: ["categorie"],
    where: { borneId, date: { gte: du, lte: au } },
    _sum: { montantCents: true },
  });
  const parCategorie = Object.fromEntries(lignes.map((l) => [l.categorie, l._sum.montantCents ?? 0]));
  return { total: lignes.reduce((s, l) => s + (l._sum.montantCents ?? 0), 0), parCategorie };
}

/** Marge nette d'une borne sur une période. */
export async function rentabiliteBorne(borneId: number, du: Date, au: Date) {
  const borne = await prisma.borne.findUniqueOrThrow({ where: { id: borneId } });
  const [ca, commissionsCents, couts] = await Promise.all([caBorne(borneId, du, au), commissionsBorne(borneId, du, au), coutsBorne(borneId, du, au)]);
  const amortissementCents = Math.round(amortissement(borne, du, au));
  return {
    ...ca,
    commissionsCents,
    coutsCents: couts.total,
    coutsParCategorie: couts.parCategorie,
    amortissementCents,
    margeNetteCents: ca.caHtCents - commissionsCents - couts.total - amortissementCents,
  };
}

/**
 * Retour sur investissement : depuis la mise en service, la marge avant amortissement
 * (CA HT − commissions − coûts) rembourse-t-elle le prix d'achat ? Série mensuelle
 * pour trouver la date de retour, ou estimation au rythme des 3 derniers mois complets.
 */
export async function retourInvestissement(borneId: number, aujourdhui: Date) {
  const borne = await prisma.borne.findUniqueOrThrow({
    where: { id: borneId },
    include: { affectations: { orderBy: { debut: "asc" }, take: 1 } },
  });
  const debut = borne.dateMiseEnService ?? borne.affectations[0]?.debut ?? null;
  if (!borne.coutAchatCents || !debut) return null;

  const depart = new Date(Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth(), debut.getUTCDate()));
  const mois: { mois: string; margeCents: number; cumulCents: number }[] = [];
  let cumul = 0;
  let dateRetour: string | null = null;
  for (let d = new Date(Date.UTC(depart.getUTCFullYear(), depart.getUTCMonth(), 1)); d <= aujourdhui; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const du = max(d, depart);
    const au = min(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)), aujourdhui);
    const [ca, commissions, couts] = await Promise.all([caBorne(borneId, du, au), commissionsBorne(borneId, du, au), coutsBorne(borneId, du, au)]);
    const marge = ca.caHtCents - commissions - couts.total;
    cumul += marge;
    mois.push({ mois: ymd(d).slice(0, 7), margeCents: marge, cumulCents: cumul });
    if (!dateRetour && cumul >= borne.coutAchatCents) dateRetour = ymd(au);
  }

  // Rythme : moyenne des 3 derniers mois complets
  const complets = mois.slice(0, -1).slice(-3);
  const rythme = complets.length ? complets.reduce((s, m) => s + m.margeCents, 0) / complets.length : null;
  const reste = Math.max(0, borne.coutAchatCents - cumul);
  return {
    coutAchatCents: borne.coutAchatCents,
    depuis: ymd(depart),
    cumulMargeCents: cumul,
    partRemboursee: Math.min(1, Math.max(0, cumul / borne.coutAchatCents)),
    dateRetour,
    margeMensuelleCents: rythme === null ? null : Math.round(rythme),
    moisRestants: dateRetour ? 0 : rythme && rythme > 0 ? Math.ceil(reste / rythme) : null,
    mois,
  };
}
