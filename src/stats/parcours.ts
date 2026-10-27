import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { conditionsLieu, et, ymd, type Filtres } from "./filtres.js";

// Entonnoir du parcours invité (avenant du 26/10/2026), sur les séances commencées dans la période.

export const ETAPES = ["cadre", "prise", "photo", "revelation", "offre", "paiement", "paiement_demande", "impression"] as const;

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const FROM = Prisma.sql`FROM parcours p JOIN lieux l ON l.id = p.lieu_id JOIN bornes b ON b.id = p.borne_id`;

function conditions(f: Filtres) {
  const c = [Prisma.sql`p.jour_local BETWEEN ${ymd(f.du)}::date AND ${ymd(f.au)}::date`, ...conditionsLieu(f)];
  if (f.gammeId?.length) c.push(Prisma.sql`b.gamme_id IN (${Prisma.join(f.gammeId)})`);
  return et(c);
}

/** Durée médiane (s) entre deux étapes, sur les séances qui ont atteint les deux. */
const mediane = (de: string, a: string) =>
  Prisma.sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ((p.etapes->>${a})::timestamptz - (p.etapes->>${de})::timestamptz)))
    FILTER (WHERE (p.etapes ->> ${de}) IS NOT NULL AND (p.etapes ->> ${a}) IS NOT NULL)`;

export async function entonnoir(f: Filtres) {
  const where = conditions(f);
  const [totaux] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT count(*) commencees,
           ${Prisma.join(ETAPES.map((e) => Prisma.sql`count(*) FILTER (WHERE (p.etapes ->> ${e}) IS NOT NULL) ${Prisma.raw(`e_${e}`)}`), ", ")},
           count(*) FILTER (WHERE p.paiement_statut = 'accepte') payees,
           count(*) FILTER (WHERE p.issue = 'validee') validees,
           count(*) FILTER (WHERE p.appel) appels,
           count(*) FILTER (WHERE p.appel AND p.appel_engagee) appels_engages,
           count(*) FILTER (WHERE p.appel AND p.paiement_statut = 'accepte') appels_payes,
           count(*) FILTER (WHERE coalesce(p.recommencer, 0) > 0) avec_recommencer,
           count(*) FILTER (WHERE coalesce(p.couleurs_relances, 0) > 0) avec_relances,
           count(*) FILTER (WHERE coalesce(p.retours_offre, 0) > 0) avec_retours_offre,
           coalesce(sum(p.upsell_proposes), 0) upsell_proposes,
           coalesce(sum(p.upsell_acceptes), 0) upsell_acceptes,
           coalesce(sum(p.upsell_montant_cents), 0) upsell_montant,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY p.duree_s) duree_mediane,
           ${mediane("cadre", "photo")} cadre_photo,
           ${mediane("photo", "offre")} photo_offre,
           ${mediane("offre", "paiement_demande")} offre_paiement,
           ${mediane("paiement_demande", "impression")} paiement_impression
    ${FROM} WHERE ${where}`;
  const etapes = Object.fromEntries(ETAPES.map((e) => [e, n(totaux[`e_${e}`])])) as Record<(typeof ETAPES)[number], number>;

  const [issues, parCadre, parHeure] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>`SELECT p.issue, count(*) nb ${FROM} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(p.cadre, '') cadre, count(*) nb,
             count(*) FILTER (WHERE (p.etapes ->> 'offre') IS NOT NULL) offres,
             count(*) FILTER (WHERE p.paiement_statut = 'accepte') payees
      ${FROM} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT p.heure_locale heure, count(*) nb, count(*) FILTER (WHERE p.paiement_statut = 'accepte') payees
      ${FROM} WHERE ${where} GROUP BY 1 ORDER BY 1`,
  ]);

  return {
    commencees: n(totaux.commencees),
    etapes,
    payees: n(totaux.payees),
    validees: n(totaux.validees),
    issues: issues.map((r) => ({ issue: r.issue as string, nb: n(r.nb) })),
    appels: { lancees: n(totaux.appels), engagees: n(totaux.appels_engages), payees: n(totaux.appels_payes) },
    hesitations: {
      avecRecommencer: n(totaux.avec_recommencer),
      avecRelancesCouleurs: n(totaux.avec_relances),
      avecRetoursOffre: n(totaux.avec_retours_offre),
    },
    upsell: { proposes: n(totaux.upsell_proposes), acceptes: n(totaux.upsell_acceptes), montantCents: n(totaux.upsell_montant) },
    dureesMedianesS: {
      seance: totaux.duree_mediane === null ? null : Math.round(n(totaux.duree_mediane)),
      cadreAPhoto: totaux.cadre_photo === null ? null : Math.round(n(totaux.cadre_photo)),
      photoAOffre: totaux.photo_offre === null ? null : Math.round(n(totaux.photo_offre)),
      offreAPaiement: totaux.offre_paiement === null ? null : Math.round(n(totaux.offre_paiement)),
      paiementAImpression: totaux.paiement_impression === null ? null : Math.round(n(totaux.paiement_impression)),
    },
    parCadre: parCadre.map((r) => ({ cadre: (r.cadre as string) || null, commencees: n(r.nb), offres: n(r.offres), payees: n(r.payees) })),
    parHeure: parHeure.map((r) => ({ heure: n(r.heure), commencees: n(r.nb), payees: n(r.payees) })),
  };
}

/** Séances où une photo a été prise, d'après les parcours (null : aucun parcours reçu sur la période). */
export async function photosPrisesParcours(f: Filtres): Promise<number | null> {
  const [r] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT count(*) nb, count(*) FILTER (WHERE (p.etapes ->> 'photo') IS NOT NULL) photos ${FROM} WHERE ${conditions(f)}`;
  return n(r.nb) ? n(r.photos) : null;
}
