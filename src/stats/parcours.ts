import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { conditionsLieu, conditionsVentes, et, ymd, type Filtres } from "./filtres.js";
import { reglagesSchema } from "../config-evenement/reglages.js";
import { compositionsDeLEvenement, nomPreview } from "../config-evenement/generation.js";

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

  const [issues, parCadre, parHeure, nonAboutis, tentatives] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>`SELECT p.issue, count(*) nb ${FROM} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(p.cadre, '') cadre, count(*) nb,
             count(*) FILTER (WHERE (p.etapes ->> 'offre') IS NOT NULL) offres,
             count(*) FILTER (WHERE p.paiement_statut = 'accepte') payees
      ${FROM} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT p.heure_locale heure, count(*) nb, count(*) FILTER (WHERE p.paiement_statut = 'accepte') payees
      ${FROM} WHERE ${where} GROUP BY 1 ORDER BY 1`,
    // Pourquoi le paiement n'a pas abouti (retour de Sébastien) : séances qui ont vu la fenêtre de paiement sans payer…
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT CASE WHEN (p.etapes ->> 'paiement_demande') IS NULL THEN 'non_demande' ELSE coalesce(p.paiement_statut, 'inconnu') END raison, count(*) nb
      ${FROM} WHERE ${where} AND (p.etapes ->> 'paiement') IS NOT NULL AND coalesce(p.paiement_statut, '') <> 'accepte'
      GROUP BY 1 ORDER BY 2 DESC`,
    // … et chaque tentative refusée, annulée ou sans réponse du terminal, avec le motif envoyé par la borne
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT a.statut::text statut, a.motif::text motif, count(*) nb
      FROM transactions a JOIN lieux l ON l.id = a.lieu_id JOIN bornes b ON b.id = a.borne_id
      WHERE a.statut IN ('REFUSEE', 'ANNULEE', 'EXPIREE') AND ${et([...conditionsVentes(f, "a.jour_local"), ...conditionsLieu(f)])}
      GROUP BY 1, 2 ORDER BY 3 DESC`,
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
    nonAboutis: nonAboutis.map((r) => ({ raison: r.raison as string, nb: n(r.nb) })),
    tentativesEchouees: tentatives.map((r) => ({ statut: r.statut as string, motif: (r.motif as string | null) ?? null, nb: n(r.nb) })),
  };
}

/**
 * Vignettes des cadres d'un lieu, par nom de gabarit renvoyé dans les parcours (polaroid_preview_2…) :
 * le cadre dessiné au studio pour l'événement où ce gabarit a le plus servi. Sans cadre du studio : absent.
 */
export async function apercusCadres(lieuId: number, f: Filtres): Promise<Record<string, string>> {
  const usages = await prisma.$queryRaw<{ cadre: string; evenement: string }[]>`
    SELECT DISTINCT ON (p.cadre) p.cadre, p.evenement
    FROM parcours p
    WHERE p.lieu_id = ${lieuId} AND p.cadre IS NOT NULL AND p.jour_local BETWEEN ${ymd(f.du)}::date AND ${ymd(f.au)}::date
    GROUP BY p.cadre, p.evenement ORDER BY p.cadre, count(*) DESC`;
  if (!usages.length) return {};
  const configs = await prisma.configEvenement.findMany({
    where: { lieuId, code: { in: [...new Set(usages.map((u) => u.evenement))] } },
    select: { code: true, reglages: true, cadres: { select: { compositionId: true, vignette: true } } },
  });
  const apercus: Record<string, string> = {};
  for (const c of configs) {
    const r = reglagesSchema.safeParse(c.reglages);
    if (!r.success) continue;
    const parNom = new Map(compositionsDeLEvenement(r.data).map((x) => [nomPreview(x.fichiers.preview), x.composition.id]));
    for (const u of usages.filter((u) => u.evenement === c.code)) {
      const vignette = c.cadres.find((k) => k.compositionId === parNom.get(u.cadre))?.vignette;
      if (vignette) apercus[u.cadre] = vignette;
    }
  }
  return apercus;
}

/** Séances où une photo a été prise, d'après les parcours (null : aucun parcours reçu sur la période). */
export async function photosPrisesParcours(f: Filtres): Promise<number | null> {
  const [r] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT count(*) nb, count(*) FILTER (WHERE (p.etapes ->> 'photo') IS NOT NULL) photos ${FROM} WHERE ${conditions(f)}`;
  return n(r.nb) ? n(r.photos) : null;
}
