import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { conditionsLieu, et, ymd, type Filtres } from "./filtres.js";

/**
 * Privatisations dans les chiffres (demande de Sébastien du 26/11/2026). Elles comptent au CA du lieu, à part des
 * ventes d'impression, en entier le jour de leur début.
 */

/** TTC d'un montant HT ; taux en points de base (2000 = 20 %). Une privatisation offerte vaut 0. */
export function montantsPrivatisation(montantHtCents: number, tauxTvaBp: number, offerte: boolean) {
  if (offerte) return { montantHtCents: 0, montantTtcCents: 0 };
  return { montantHtCents, montantTtcCents: Math.round((montantHtCents * (10_000 + tauxTvaBp)) / 10_000) };
}

/**
 * Une privatisation n'a ni borne, ni module, ni moyen de paiement : avec l'un de ces filtres, elle ne compte pas
 * (le chiffre affiché est celui de ces ventes-là seulement).
 */
export const privatisationsComptees = (f: Filtres) => !f.gammeId?.length && !f.typeModuleId?.length && !f.moyenPaiement?.length;

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

const conditions = (f: Filtres) =>
  et([Prisma.sql`p.debut BETWEEN ${ymd(f.du)}::date AND ${ymd(f.au)}::date`, ...conditionsLieu(f)]);

export type TotauxPrivatisations = { nb: number; nbOffertes: number; caTtcCents: number; caHtCents: number };

const VIDE: TotauxPrivatisations = { nb: 0, nbOffertes: 0, caTtcCents: 0, caHtCents: 0 };

/** Privatisations qui commencent dans la période. */
export async function totauxPrivatisations(f: Filtres): Promise<TotauxPrivatisations> {
  if (!privatisationsComptees(f)) return VIDE;
  const [r] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT count(*) nb, count(*) FILTER (WHERE p.offerte) offertes,
           coalesce(sum(p.montant_ttc_cents), 0) ttc, coalesce(sum(p.montant_ht_cents), 0) ht
    FROM privatisations p JOIN lieux l ON l.id = p.lieu_id
    WHERE ${conditions(f)}`;
  return { nb: n(r.nb), nbOffertes: n(r.offertes), caTtcCents: n(r.ttc), caHtCents: n(r.ht) };
}

/** Par période (jour, semaine… : `troncature` au format date_trunc), clé AAAA-MM-JJ du début de période. */
export async function seriePrivatisations(f: Filtres, troncature: string, decalageAns = 0) {
  const parPeriode = new Map<string, TotauxPrivatisations>();
  if (!privatisationsComptees(f)) return parPeriode;
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT (date_trunc(${troncature}, p.debut::timestamp) + make_interval(years => ${decalageAns}::int))::date periode,
           count(*) nb, count(*) FILTER (WHERE p.offerte) offertes,
           sum(p.montant_ttc_cents) ttc, sum(p.montant_ht_cents) ht
    FROM privatisations p JOIN lieux l ON l.id = p.lieu_id
    WHERE ${conditions(f)}
    GROUP BY 1`;
  for (const r of rows) {
    parPeriode.set(ymd(r.periode as Date), { nb: n(r.nb), nbOffertes: n(r.offertes), caTtcCents: n(r.ttc), caHtCents: n(r.ht) });
  }
  return parPeriode;
}

/** Par lieu, pour le classement. */
export async function privatisationsParLieu(f: Filtres) {
  const parLieu = new Map<number, TotauxPrivatisations>();
  if (!privatisationsComptees(f)) return parLieu;
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT p.lieu_id, count(*) nb, count(*) FILTER (WHERE p.offerte) offertes,
           sum(p.montant_ttc_cents) ttc, sum(p.montant_ht_cents) ht
    FROM privatisations p JOIN lieux l ON l.id = p.lieu_id
    WHERE ${conditions(f)}
    GROUP BY 1`;
  for (const r of rows) {
    parLieu.set(n(r.lieu_id), { nb: n(r.nb), nbOffertes: n(r.offertes), caTtcCents: n(r.ttc), caHtCents: n(r.ht) });
  }
  return parLieu;
}
