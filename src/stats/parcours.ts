import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { conditionsLieu, conditionsVentes, et, periodesComparaison, ymd, type Filtres } from "./filtres.js";
import { reglagesSchema } from "../config-evenement/reglages.js";
import { compositionsDeLEvenement, nomPreview } from "../config-evenement/generation.js";

// Entonnoir du parcours invité (avenant du 26/10/2026), sur les séances commencées dans la période.

export const ETAPES = ["cadre", "prise", "photo", "revelation", "offre", "paiement", "paiement_demande", "impression"] as const;

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const FROM = Prisma.sql`FROM parcours p JOIN lieux l ON l.id = p.lieu_id JOIN bornes b ON b.id = p.borne_id`;

// Soirée d'une séance : une séance avant 6 h appartient à la soirée de la veille (vendredi 1 h = soirée du vendredi)
const SOIREE = Prisma.sql`(p.jour_local - (CASE WHEN p.heure_locale < 6 THEN 1 ELSE 0 END))`;
/** Séances « sans rien » : revenues à l'accueil ou abandonnées par inactivité */
const SANS_RIEN = Prisma.sql`p.issue IN ('retour', 'delai')`;
const PAYEE = Prisma.sql`coalesce(p.paiement_statut, '') = 'accepte'`;
/** Photo enregistrée par la borne (issue « validee », ou photo envoyée à PikCloud) */
const PHOTO_GARDEE = Prisma.sql`(p.issue = 'validee' OR p.photo_uuid IS NOT NULL)`;
/** Ce que devient la séance (maquette du 10/11) : payée, photo gardée sans tirage, ou photo non validée (rien n'est gardé) */
const SORTIE = Prisma.sql`(CASE WHEN ${PAYEE} THEN 'payee' WHEN ${PHOTO_GARDEE} THEN 'gardee' ELSE 'non_validee' END)`;
/**
 * Dernière marche du ruban atteinte : avant la photo, photo prise, offre vue, paiement demandé.
 * Une séance payée a forcément demandé à payer, une photo gardée a forcément été prise : les branches de l'arbre restent disjointes.
 */
const MARCHE = Prisma.sql`(CASE WHEN ${PAYEE} OR (p.etapes ->> 'paiement_demande') IS NOT NULL THEN 'paiement'
  WHEN (p.etapes ->> 'offre') IS NOT NULL THEN 'offre'
  WHEN (p.etapes ->> 'prise') IS NOT NULL OR (p.etapes ->> 'photo') IS NOT NULL OR ${PHOTO_GARDEE} THEN 'photo'
  ELSE 'avant_photo' END)`;
/** Tranche fixe de 2 h, calée sur les heures paires (0, 2… 22) */
const TRANCHE = Prisma.sql`((p.heure_locale / 2) * 2)`;

/** Options du parcours : soirs de la semaine retenus (ISO, 1 = lundi), d'après la soirée de la séance */
export interface OptionsParcours {
  soirs?: number[];
}

function conditions(f: Filtres, o: OptionsParcours = {}) {
  const c = [Prisma.sql`p.jour_local BETWEEN ${ymd(f.du)}::date AND ${ymd(f.au)}::date`, ...conditionsLieu(f)];
  if (f.gammeId?.length) c.push(Prisma.sql`b.gamme_id IN (${Prisma.join(f.gammeId)})`);
  if (o.soirs?.length) c.push(Prisma.sql`extract(isodow FROM ${SOIREE})::int IN (${Prisma.join(o.soirs)})`);
  return et(c);
}

/** Les cinq clés d'une période (comparaison avec la période précédente) */
async function cles(f: Filtres, o: OptionsParcours) {
  const [r] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT count(*) commencees,
           count(*) FILTER (WHERE ${MARCHE} = 'paiement') paiement_demande,
           count(*) FILTER (WHERE ${PAYEE}) payees,
           count(*) FILTER (WHERE coalesce(p.recommencer, 0) > 0) recommencent,
           count(*) FILTER (WHERE ${SANS_RIEN}) sans_rien,
           count(*) FILTER (WHERE ${SORTIE} = 'non_validee') non_validees
    ${FROM} WHERE ${conditions(f, o)}`;
  return {
    commencees: n(r.commencees),
    paiementDemande: n(r.paiement_demande),
    payees: n(r.payees),
    recommencent: n(r.recommencent),
    sansRien: n(r.sans_rien),
    nonValidees: n(r.non_validees),
  };
}

/** Durée médiane (s) entre deux étapes, sur les séances qui ont atteint les deux. */
const mediane = (de: string, a: string) =>
  Prisma.sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ((p.etapes->>${a})::timestamptz - (p.etapes->>${de})::timestamptz)))
    FILTER (WHERE (p.etapes ->> ${de}) IS NOT NULL AND (p.etapes ->> ${a}) IS NOT NULL)`;

export async function entonnoir(f: Filtres, o: OptionsParcours = {}) {
  const where = conditions(f, o);
  const [totaux] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT count(*) commencees,
           ${Prisma.join(ETAPES.map((e) => Prisma.sql`count(*) FILTER (WHERE (p.etapes ->> ${e}) IS NOT NULL) ${Prisma.raw(`e_${e}`)}`), ", ")},
           count(*) FILTER (WHERE ${PAYEE}) payees,
           count(*) FILTER (WHERE p.issue = 'validee') validees,
           count(*) FILTER (WHERE p.appel) appels,
           count(*) FILTER (WHERE p.appel AND p.appel_engagee) appels_engages,
           count(*) FILTER (WHERE p.appel AND ${PAYEE}) appels_payes,
           count(*) FILTER (WHERE coalesce(p.recommencer, 0) > 0) avec_recommencer,
           count(*) FILTER (WHERE coalesce(p.couleurs_relances, 0) > 0) avec_relances,
           count(*) FILTER (WHERE coalesce(p.retours_offre, 0) > 0) avec_retours_offre,
           count(*) FILTER (WHERE coalesce(p.recommencer, 0) > 0 AND ${SANS_RIEN}) recommencer_sans_rien,
           count(*) FILTER (WHERE p.issue = 'retour') retours_accueil,
           count(*) FILTER (WHERE p.issue = 'delai') delais,
           count(DISTINCT (p.borne_id, ${SOIREE})) soirees,
           coalesce(sum(p.upsell_proposes), 0) upsell_proposes,
           coalesce(sum(p.upsell_acceptes), 0) upsell_acceptes,
           coalesce(sum(p.upsell_montant_cents), 0) upsell_montant,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY p.duree_s) duree_mediane,
           ${mediane("cadre", "photo")} cadre_photo,
           ${mediane("photo", "offre")} photo_offre,
           ${mediane("offre", "paiement_demande")} offre_paiement,
           ${mediane("paiement_demande", "impression")} paiement_impression,
           -- Temps passé par ceux qui partent avant la photo, et devant l'offre par ceux qui la ferment sans payer
           percentile_cont(0.5) WITHIN GROUP (ORDER BY p.duree_s) FILTER (WHERE ${MARCHE} = 'avant_photo') avant_photo,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (p.fin - (p.etapes ->> 'offre')::timestamptz)))
             FILTER (WHERE ${MARCHE} = 'offre') devant_offre
    ${FROM} WHERE ${where}`;
  const etapes = Object.fromEntries(ETAPES.map((e) => [e, n(totaux[`e_${e}`])])) as Record<(typeof ETAPES)[number], number>;

  const [arbre, parCadre, parBorne, parBorneJour, muets, precedente] = await Promise.all([
    // Arbre « Ce que devient chaque invité » : chaque séance une fois, par dernière marche atteinte et par sortie ;
    // le détail (issue, statut du paiement, hésitations) sert aux bulles. Le navigateur fait les sommes.
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT ${MARCHE} marche, ${SORTIE} sortie, p.issue, coalesce(p.paiement_statut, '') statut,
             coalesce(p.recommencer, 0) > 0 recommence, coalesce(p.retours_offre, 0) > 0 retour_offre,
             (p.etapes ->> 'cadre') IS NULL sans_cadre, count(*) nb
      ${FROM} WHERE ${where} GROUP BY 1, 2, 3, 4, 5, 6, 7`,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(p.cadre, '') cadre, count(*) nb,
             count(*) FILTER (WHERE (p.etapes ->> 'offre') IS NOT NULL) offres,
             count(*) FILTER (WHERE ${PAYEE}) payees
      ${FROM} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
    // Borne par borne : les mêmes clés, pour repérer une borne loin du parc
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT b.id borne_id, b.identifiant, l.id lieu_id, l.enseigne, count(*) nb,
             count(*) FILTER (WHERE ${MARCHE} = 'paiement') paiement_demande,
             count(*) FILTER (WHERE ${PAYEE}) payees,
             count(*) FILTER (WHERE coalesce(p.recommencer, 0) > 0) recommencent,
             count(*) FILTER (WHERE ${SORTIE} = 'non_validee') non_validees,
             ${mediane("photo", "offre")} photo_offre
      ${FROM} WHERE ${where} GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC`,
    // Séances par soirée et par borne : petite courbe de la période
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT p.borne_id, ${SOIREE}::text soiree, count(*) nb
      ${FROM} WHERE ${where} GROUP BY 1, 2`,
    // Terminal sans réponse, par borne
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT a.borne_id, count(*) nb
      FROM transactions a JOIN lieux l ON l.id = a.lieu_id JOIN bornes b ON b.id = a.borne_id
      WHERE a.statut = 'EXPIREE' AND ${et([...conditionsVentes(f, "a.jour_local"), ...conditionsLieu(f)])}
      GROUP BY 1`,
    // Période de même durée juste avant, pour les évolutions des clés
    cles({ ...f, ...periodesComparaison(f).precedente }, o),
  ]);
  const jours = Math.round((f.au.getTime() - f.du.getTime()) / 86_400_000) + 1;
  const muetsParBorne = new Map(muets.map((m) => [n(m.borne_id), n(m.nb)]));
  const secondes = (v: unknown) => (v === null || v === undefined ? null : Math.round(n(v)));

  return {
    commencees: n(totaux.commencees),
    etapes,
    payees: n(totaux.payees),
    validees: n(totaux.validees),
    appels: { lancees: n(totaux.appels), engagees: n(totaux.appels_engages), payees: n(totaux.appels_payes) },
    sansRien: { total: n(totaux.retours_accueil) + n(totaux.delais), retoursAccueil: n(totaux.retours_accueil), delais: n(totaux.delais) },
    // Séances par borne et par soirée
    soirees: n(totaux.soirees),
    hesitations: {
      recommencerPuisSansRien: n(totaux.recommencer_sans_rien),
      avecRecommencer: n(totaux.avec_recommencer),
      avecRelancesCouleurs: n(totaux.avec_relances),
      avecRetoursOffre: n(totaux.avec_retours_offre),
    },
    upsell: { proposes: n(totaux.upsell_proposes), acceptes: n(totaux.upsell_acceptes), montantCents: n(totaux.upsell_montant) },
    dureesMedianesS: {
      seance: secondes(totaux.duree_mediane),
      cadreAPhoto: secondes(totaux.cadre_photo),
      photoAOffre: secondes(totaux.photo_offre),
      offreAPaiement: secondes(totaux.offre_paiement),
      paiementAImpression: secondes(totaux.paiement_impression),
      avantPhoto: secondes(totaux.avant_photo),
      devantOffre: secondes(totaux.devant_offre),
    },
    arbre: arbre.map((r) => ({
      marche: r.marche as string,
      sortie: r.sortie as string,
      issue: r.issue as string,
      statut: (r.statut as string) || null,
      recommence: Boolean(r.recommence),
      retourOffre: Boolean(r.retour_offre),
      sansCadre: Boolean(r.sans_cadre),
      nb: n(r.nb),
    })),
    parCadre: parCadre.map((r) => ({ cadre: (r.cadre as string) || null, commencees: n(r.nb), offres: n(r.offres), payees: n(r.payees) })),
    parBorne: parBorne.map((r) => {
      const id = n(r.borne_id);
      // Séances par soirée, regroupées en 10 tranches de la période (petite courbe)
      const tranches = Array.from({ length: Math.min(10, jours) }, () => 0);
      for (const j of parBorneJour.filter((x) => n(x.borne_id) === id)) {
        const i = Math.floor(((new Date(`${String(j.soiree).slice(0, 10)}T00:00:00Z`).getTime() - f.du.getTime()) / 86_400_000 / jours) * tranches.length);
        tranches[Math.max(0, Math.min(tranches.length - 1, i))] += n(j.nb);
      }
      return {
        borneId: id,
        identifiant: r.identifiant as string,
        lieu: r.lieu_id === null ? null : { id: n(r.lieu_id), enseigne: r.enseigne as string },
        commencees: n(r.nb),
        paiementDemande: n(r.paiement_demande),
        payees: n(r.payees),
        recommencent: n(r.recommencent),
        nonValidees: n(r.non_validees),
        photoAOffreS: secondes(r.photo_offre),
        terminalMuet: muetsParBorne.get(id) ?? 0,
        tendance: tranches,
      };
    }),
    precedente,
  };
}

/**
 * Page « Par heure » (maquette du 10/11) : les indicateurs de Comportements par tranche fixe de 2 h,
 * et le taux payé de chaque borne par tranche. La journée va de 6 h à 6 h : c'est le navigateur qui ordonne les tranches.
 * Lignes du tableau disjointes : payées + non validées + ferment l'offre + paiement non abouti = séances de la tranche.
 */
export async function parcoursParTranche(f: Filtres, o: OptionsParcours = {}) {
  const where = conditions(f, o);
  const [tranches, bornes] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT ${TRANCHE} tranche, count(*) nb,
             count(*) FILTER (WHERE ${SORTIE} = 'payee') payees,
             count(*) FILTER (WHERE ${SORTIE} = 'non_validee') non_validees,
             count(*) FILTER (WHERE ${SORTIE} = 'non_validee' AND ${MARCHE} = 'avant_photo') avant_photo,
             count(*) FILTER (WHERE ${SORTIE} = 'gardee' AND ${MARCHE} <> 'paiement') ferment_offre,
             count(*) FILTER (WHERE ${SORTIE} = 'gardee' AND ${MARCHE} = 'paiement') non_aboutis,
             count(*) FILTER (WHERE coalesce(p.recommencer, 0) > 0) recommencent,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY p.duree_s) duree,
             coalesce(sum(p.upsell_proposes), 0) upsell_proposes,
             coalesce(sum(p.upsell_acceptes), 0) upsell_acceptes
      ${FROM} WHERE ${where} GROUP BY 1`,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT b.id borne_id, b.identifiant, l.id lieu_id, l.enseigne, ${TRANCHE} tranche, count(*) nb, count(*) FILTER (WHERE ${PAYEE}) payees
      ${FROM} WHERE ${where} GROUP BY 1, 2, 3, 4, 5`,
  ]);

  const parBorne = new Map<number, { borneId: number; identifiant: string; lieu: { id: number; enseigne: string } | null; commencees: number; payees: number; tranches: { debut: number; commencees: number; payees: number }[] }>();
  for (const r of bornes) {
    const id = n(r.borne_id);
    const b = parBorne.get(id) ?? { borneId: id, identifiant: r.identifiant as string, lieu: r.lieu_id === null ? null : { id: n(r.lieu_id), enseigne: r.enseigne as string }, commencees: 0, payees: 0, tranches: [] };
    b.commencees += n(r.nb);
    b.payees += n(r.payees);
    b.tranches.push({ debut: n(r.tranche), commencees: n(r.nb), payees: n(r.payees) });
    parBorne.set(id, b);
  }

  return {
    tranches: tranches.map((r) => ({
      debut: n(r.tranche),
      commencees: n(r.nb),
      payees: n(r.payees),
      nonValidees: n(r.non_validees),
      avantPhoto: n(r.avant_photo),
      fermentOffre: n(r.ferment_offre),
      nonAboutis: n(r.non_aboutis),
      recommencent: n(r.recommencent),
      dureeMedianeS: r.duree === null ? null : Math.round(n(r.duree)),
      upsellProposes: n(r.upsell_proposes),
      upsellAcceptes: n(r.upsell_acceptes),
    })),
    parBorne: [...parBorne.values()].sort((a, b) => b.commencees - a.commencees),
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
