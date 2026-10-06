import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import { perimetreLieux, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { conditionsLieu, conditionsVentes, et, lireFiltres, periodesComparaison, ymd, type Filtres } from "../stats/filtres.js";
import { joursOuverts } from "../alertes/ouverture.js";
import { disponibilite } from "../stats/disponibilite.js";

/** Filtres de la requête, restreints au périmètre de l'utilisateur (ses lieux pour un commercial). */
export function filtresAutorises(req: UtilisateurRequest): Filtres {
  const f = lireFiltres(req.query);
  const p = perimetreLieux(req.utilisateur);
  if (p?.commercialId !== undefined) f.commercialId = [p.commercialId];
  if (p?.lieuId !== undefined) f.lieuId = [p.lieuId];
  return f;
}

export const statsRouter = Router();

const GRANULARITES = { jour: "day", semaine: "week", mois: "month", annee: "year" } as const;
const granularite = z.enum(Object.keys(GRANULARITES) as [keyof typeof GRANULARITES]).default("jour");

// Les sommes PostgreSQL sont des bigint : converties en number (exact jusqu'à 2^53)
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

const FROM_AGG = Prisma.sql`FROM agg_jour a JOIN lieux l ON l.id = a.lieu_id JOIN bornes b ON b.id = a.borne_id`;

async function kpis(f: Filtres) {
  const [r] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT sum(a.ca_ttc_cents) ca_ttc, sum(a.ca_ht_cents) ca_ht, sum(a.nb_acceptees) nb,
           sum(a.nb_refusees) refus, sum(a.nb_annulees) annul, sum(a.rembourse_ttc_cents) rembourse,
           count(DISTINCT a.lieu_id) FILTER (WHERE a.nb_acceptees > 0) lieux_actifs
    ${FROM_AGG}
    WHERE ${et([...conditionsVentes(f), ...conditionsLieu(f)])}`;
  const nb = n(r.nb);
  const refus = n(r.refus);
  return {
    caTtcCents: n(r.ca_ttc),
    caHtCents: n(r.ca_ht),
    nbVentes: nb,
    panierMoyenCents: nb ? Math.round(n(r.ca_ttc) / nb) : 0,
    rembourseTtcCents: n(r.rembourse),
    nbRefusees: refus,
    nbAnnulees: n(r.annul),
    tauxRefus: nb + refus ? refus / (nb + refus) : 0,
    lieuxAvecVentes: n(r.lieux_actifs),
  };
}

async function serie(f: Filtres, gran: keyof typeof GRANULARITES, decalageAns = 0) {
  const rows = await prisma.$queryRaw<{ periode: Date; ca: unknown; nb: unknown }[]>`
    SELECT (date_trunc(${GRANULARITES[gran]}, a.jour::timestamp) + make_interval(years => ${decalageAns}::int))::date periode,
           sum(a.ca_ttc_cents) ca, sum(a.nb_acceptees) nb
    ${FROM_AGG}
    WHERE ${et([...conditionsVentes(f), ...conditionsLieu(f)])}
    GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => ({ periode: ymd(r.periode), caTtcCents: n(r.ca), nbVentes: n(r.nb) }));
}

async function comparaisons(f: Filtres) {
  const { precedente, n1 } = periodesComparaison(f);
  const [courant, prec, anN1] = await Promise.all([kpis(f), kpis({ ...f, ...precedente }), kpis({ ...f, ...n1 })]);
  return { courant, precedente: { ...prec, ...periode(precedente) }, n1: { ...anN1, ...periode(n1) } };
}

const periode = (p: { du: Date; au: Date }) => ({ du: ymd(p.du), au: ymd(p.au) });

// Début du jour `du` et fin du jour `au` (heure de Paris), en timestamptz
const debutParis = (d: Date) => Prisma.sql`(${ymd(d)}::date::timestamp AT TIME ZONE 'Europe/Paris')`;
const finParis = (d: Date) => Prisma.sql`((${ymd(d)}::date + 1)::timestamp AT TIME ZONE 'Europe/Paris')`;

export async function classement(f: Filtres) {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    WITH ventes AS (
      SELECT a.lieu_id, sum(a.ca_ttc_cents) ca, sum(a.nb_acceptees) nb,
             count(DISTINCT a.jour) FILTER (WHERE a.nb_acceptees > 0) jours
      ${FROM_AGG}
      WHERE ${et(conditionsVentes(f))}
      GROUP BY a.lieu_id
    )
    SELECT l.id, l.enseigne, l.ville, tl.libelle type_lieu,
           coalesce(v.ca, 0) ca, coalesce(v.nb, 0) nb, coalesce(v.jours, 0) jours
    FROM lieux l
    JOIN ref_valeurs tl ON tl.id = l.type_lieu_id
    LEFT JOIN ventes v ON v.lieu_id = l.id
    WHERE l.statut = 'ACTIF' AND ${et(conditionsLieu(f))}
    ORDER BY ca DESC, l.enseigne`;
  return rows.map((r) => ({
    lieuId: n(r.id),
    enseigne: r.enseigne as string,
    ville: r.ville as string | null,
    typeLieu: r.type_lieu as string,
    caTtcCents: n(r.ca),
    nbVentes: n(r.nb),
    joursAvecVente: n(r.jours),
    caParJourVenteCents: n(r.jours) ? Math.round(n(r.ca) / n(r.jours)) : 0,
  }));
}

async function parc(f: Filtres) {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT b.id, b.identifiant, b.derniere_vente, b.dernier_heartbeat, l.id lieu_id, l.enseigne,
           EXISTS (
             SELECT 1 FROM agg_jour a
             WHERE a.borne_id = b.id AND a.nb_acceptees > 0 AND ${et(conditionsVentes(f))}
           ) active
    FROM bornes b
    JOIN affectations_borne af ON af.borne_id = b.id AND af.fin IS NULL
    JOIN lieux l ON l.id = af.lieu_id
    WHERE ${et([...conditionsLieu(f), ...(f.gammeId?.length ? [Prisma.sql`b.gamme_id IN (${Prisma.join(f.gammeId)})`] : [])])}
    ORDER BY b.identifiant`;
  const [{ count: nonAffectees }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) FROM bornes b
    WHERE b.statut <> 'REFORMEE' AND NOT EXISTS (SELECT 1 FROM affectations_borne af WHERE af.borne_id = b.id AND af.fin IS NULL)`;
  const bornes = rows.map((r) => ({
    borneId: n(r.id),
    identifiant: r.identifiant as string,
    lieuId: n(r.lieu_id),
    lieu: r.enseigne as string,
    derniereVente: r.derniere_vente as Date | null,
    dernierHeartbeat: r.dernier_heartbeat as Date | null,
    active: Boolean(r.active),
  }));
  return {
    bornesAffectees: bornes.length,
    actives: bornes.filter((b) => b.active).length,
    inactives: bornes.filter((b) => !b.active),
    bornesNonAffectees: n(nonAffectees),
  };
}

/** Commissions des périodes calculées comprises dans la période affichée (réservé admin). */
async function commissionsPeriode(f: Filtres) {
  const [r] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT coalesce(sum(r.montant_a_reverser_cents), 0)::float8 montant, count(*)::int nb,
           count(*) FILTER (WHERE r.statut IN ('A_CALCULER', 'CALCULE'))::int a_valider
    FROM reversements r JOIN lieux l ON l.id = r.lieu_id
    WHERE r.periode_debut >= ${ymd(f.du)}::date AND r.periode_fin <= ${ymd(f.au)}::date AND ${et(conditionsLieu(f))}`;
  return { montantCents: n(r.montant), nbPeriodes: n(r.nb), nbAValider: n(r.a_valider) };
}

// GET /api/stats/carte?du=&au=&<filtres> — lieux sur la carte, avec leur performance (CDC §8)
statsRouter.get(
  "/carte",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const f = filtresAutorises(req);
    const { precedente } = periodesComparaison(f);
    const [courant, avant] = await Promise.all([classement(f), classement({ ...f, ...precedente })]);
    const caAvant = new Map(avant.map((l) => [l.lieuId, l.caTtcCents]));

    // Jours d'ouverture sur la période : CA par jour ouvert, comparable entre lieux saisonniers et annuels
    const lieux = await prisma.lieu.findMany({
      where: { id: { in: courant.map((l) => l.lieuId) } },
      select: { id: true, latitude: true, longitude: true, saisonnalite: true, horaires: true, saisons: true, fermetures: true },
    });
    const parId = new Map(lieux.map((l) => [l.id, l]));

    res.json({
      periode: { du: ymd(f.du), au: ymd(f.au) },
      lieux: courant.map((l) => {
        const lieu = parId.get(l.lieuId)!;
        const jo = joursOuverts(lieu, f.du, f.au);
        const precedent = caAvant.get(l.lieuId) ?? 0;
        return {
          ...l,
          latitude: lieu.latitude === null ? null : Number(lieu.latitude),
          longitude: lieu.longitude === null ? null : Number(lieu.longitude),
          joursOuverts: jo,
          caParJourOuvertCents: jo ? Math.round(l.caTtcCents / jo) : null,
          caPrecedentCents: precedent,
          evolution: precedent ? (l.caTtcCents - precedent) / precedent : null,
        };
      }),
    });
  })
);

// GET /api/stats/global?du=&au=&granularite=&<filtres>
statsRouter.get(
  "/global",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const f = filtresAutorises(req);
    const gran = granularite.parse(req.query.granularite);
    const { n1 } = periodesComparaison(f);

    const [kpi, s, sN1, cl, p, commissions] = await Promise.all([
      comparaisons(f),
      serie(f, gran),
      serie({ ...f, ...n1 }, gran, 1),
      classement(f),
      parc(f),
      req.utilisateur?.role === "ADMIN" ? commissionsPeriode(f) : Promise.resolve(null),
    ]);

    res.json({
      periode: periode(f),
      granularite: gran,
      kpis: kpi,
      serie: s,
      serieN1: sN1,
      classement: cl,
      parc: perimetreLieux(req.utilisateur) ? { ...p, bornesNonAffectees: 0 } : p,
      commissions,
    });
  })
);

// GET /api/stats/lieux/:id?du=&au=&granularite=&gammeId=&typeModuleId=&moyenPaiement=
statsRouter.get(
  "/lieux/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const f: Filtres = { ...lireFiltres(req.query), lieuId: [lieuId] };
    const gran = granularite.parse(req.query.granularite);
    const ventes = et([...conditionsVentes(f), ...conditionsLieu(f)]);
    const ventesTx = et([...conditionsVentes(f, "a.jour_local"), ...conditionsLieu(f)]);
    const FROM_TX = Prisma.sql`FROM transactions a JOIN lieux l ON l.id = a.lieu_id JOIN bornes b ON b.id = a.borne_id`;

    const [kpi, s, heatmap, joursSemaine, meilleuresDates, moyens, modules, formules, montants, bornes] =
      await Promise.all([
        comparaisons(f),
        serie(f, gran),
        // agg_heure n'a pas les dimensions module / moyen de paiement : seuls période et gamme s'appliquent
        prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT extract(isodow FROM h.jour)::int dow, h.heure, sum(h.nb_acceptees) nb, sum(h.ca_ttc_cents) ca
          FROM agg_heure h JOIN bornes b ON b.id = h.borne_id
          WHERE h.lieu_id = ${lieuId} AND h.jour BETWEEN ${ymd(f.du)}::date AND ${ymd(f.au)}::date
            ${f.gammeId?.length ? Prisma.sql`AND b.gamme_id IN (${Prisma.join(f.gammeId)})` : Prisma.empty}
          GROUP BY 1, 2`,
        prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT extract(isodow FROM a.jour)::int dow, sum(a.ca_ttc_cents) ca, sum(a.nb_acceptees) nb,
                 count(DISTINCT a.jour) FILTER (WHERE a.nb_acceptees > 0) jours
          ${FROM_AGG} WHERE ${ventes} GROUP BY 1`,
        prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT a.jour, sum(a.ca_ttc_cents) ca, sum(a.nb_acceptees) nb
          ${FROM_AGG} WHERE ${ventes} GROUP BY 1 HAVING sum(a.nb_acceptees) > 0 ORDER BY ca DESC LIMIT 10`,
        prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT a.moyen_paiement::text moyen, sum(a.ca_ttc_cents) ca, sum(a.nb_acceptees) nb, sum(a.nb_refusees) refus
          ${FROM_AGG} WHERE ${ventes} GROUP BY 1 ORDER BY ca DESC`,
        prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT tm.libelle, sum(a.ca_ttc_cents) ca, sum(a.nb_acceptees) nb, sum(a.nb_refusees) refus
          ${FROM_AGG} JOIN types_module_paiement tm ON tm.id = a.type_module_id
          WHERE ${ventes} GROUP BY 1 ORDER BY ca DESC`,
        prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT a.produit_code code, max(a.produit_libelle) libelle, count(*) nb, sum(a.montant_ttc_cents) ca
          ${FROM_TX} WHERE a.statut = 'ACCEPTEE' AND ${ventesTx} GROUP BY 1 ORDER BY ca DESC`,
        prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT a.montant_ttc_cents montant, count(*) nb
          ${FROM_TX} WHERE a.statut = 'ACCEPTEE' AND ${ventesTx} GROUP BY 1 ORDER BY 1`,
        prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT b.id, b.identifiant, g.libelle gamme, af.debut, af.fin, b.dernier_heartbeat, b.derniere_vente,
                 (SELECT count(*) FROM heartbeats hb
                  WHERE hb.borne_id = b.id
                    AND hb.horodatage >= greatest(af.debut, ${debutParis(f.du)})
                    AND hb.horodatage <  least(coalesce(af.fin, 'infinity'), ${finParis(f.au)})
                 ) heartbeats
          FROM affectations_borne af JOIN bornes b ON b.id = af.borne_id JOIN gammes g ON g.id = b.gamme_id
          WHERE af.lieu_id = ${lieuId}
            AND af.debut < ${finParis(f.au)}
            AND (af.fin IS NULL OR af.fin > ${debutParis(f.du)})
          ORDER BY af.debut DESC`,
      ]);

    // Nombre d'occurrences de chaque jour de semaine dans la période (pour les moyennes)
    const occurrences = Array(8).fill(0);
    for (let d = f.du.getTime(); d <= f.au.getTime(); d += 86_400_000) {
      occurrences[((new Date(d).getUTCDay() + 6) % 7) + 1]++;
    }

    // Interventions SAV sur les bornes du lieu : repères sur la courbe de CA (CDC §8)
    const interventions = await prisma.$queryRaw<{ date: Date; motif: string; identifiant: string }[]>`
      SELECT i.date, i.motif, b.identifiant
      FROM interventions i
      JOIN bornes b ON b.id = i.borne_id
      JOIN affectations_borne a ON a.borne_id = i.borne_id AND a.lieu_id = ${lieuId}
        AND i.date >= a.debut AND (a.fin IS NULL OR i.date < a.fin)
      WHERE i.date >= ${debutParis(f.du)} AND i.date < ${finParis(f.au)}
      ORDER BY i.date`;

    // Disponibilité de chaque borne : temps en ligne pendant l'ouverture, coupures, pannes déclarées
    const ouverture = await prisma.lieu.findUniqueOrThrow({
      where: { id: lieuId },
      select: { saisonnalite: true, horaires: true, saisons: true, fermetures: true },
    });
    const debutPeriode = new Date(f.du.getTime() - 86_400_000);
    const finPeriode = new Date(f.au.getTime() + 2 * 86_400_000);
    const dispos = await Promise.all(
      bornes.map(async (b) => {
        const borneId = n(b.id);
        const [hbs, pannes] = await Promise.all([
          prisma.heartbeat.findMany({
            where: { borneId, horodatage: { gte: debutPeriode, lt: finPeriode } },
            select: { horodatage: true },
            orderBy: { horodatage: "asc" },
          }),
          prisma.intervention.findMany({
            where: { borneId, enPanneDepuis: { not: null, lt: finPeriode }, OR: [{ resolueLe: null }, { resolueLe: { gte: debutPeriode } }] },
            select: { enPanneDepuis: true, resolueLe: true },
          }),
        ]);
        const presence = { debut: b.debut as Date, fin: b.fin as Date | null };
        return {
          ...disponibilite(ouverture, presence, f.du, f.au, hbs.map((h) => h.horodatage)),
          pannes: pannes.length,
          minutesPanne: Math.round(
            pannes.reduce((t, p) => t + ((p.resolueLe ?? new Date()).getTime() - p.enPanneDepuis!.getTime()) / 60_000, 0)
          ),
        };
      })
    );

    res.json({
      periode: periode(f),
      granularite: gran,
      kpis: kpi,
      serie: s,
      interventions: interventions.map((i) => ({
        jour: ymd(new Date(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(i.date) + "T00:00:00Z")),
        motif: i.motif,
        borne: i.identifiant,
      })),
      heatmap: heatmap.map((h) => ({ jourSemaine: n(h.dow), heure: n(h.heure), nbVentes: n(h.nb), caTtcCents: n(h.ca) })),
      joursSemaine: [1, 2, 3, 4, 5, 6, 7].map((dow) => {
        const r = joursSemaine.find((j) => n(j.dow) === dow);
        return {
          jourSemaine: dow,
          caTtcCents: n(r?.ca),
          nbVentes: n(r?.nb),
          joursAvecVente: n(r?.jours),
          caMoyenCents: occurrences[dow] ? Math.round(n(r?.ca) / occurrences[dow]) : 0,
        };
      }),
      meilleuresDates: meilleuresDates.map((d) => ({ jour: ymd(d.jour as Date), caTtcCents: n(d.ca), nbVentes: n(d.nb) })),
      moyensPaiement: moyens.map((m) => ({ moyen: m.moyen as string, caTtcCents: n(m.ca), nbVentes: n(m.nb), nbRefusees: n(m.refus) })),
      modulesPaiement: modules.map((m) => ({ libelle: m.libelle as string, caTtcCents: n(m.ca), nbVentes: n(m.nb), nbRefusees: n(m.refus) })),
      formules: formules.map((p) => ({ code: p.code as string, libelle: p.libelle as string | null, nbVentes: n(p.nb), caTtcCents: n(p.ca) })),
      montants: montants.map((m) => ({ montantCents: n(m.montant), nbVentes: n(m.nb) })),
      bornes: bornes.map((b, i) => ({
        disponibilite: dispos[i],
        borneId: n(b.id),
        identifiant: b.identifiant as string,
        gamme: b.gamme as string,
        debut: b.debut as Date,
        fin: b.fin as Date | null,
        dernierHeartbeat: b.dernier_heartbeat as Date | null,
        derniereVente: b.derniere_vente as Date | null,
        heartbeatsRecus: n(b.heartbeats),
      })),
    });
  })
);
