import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import { localParis } from "../alertes/ouverture.js";
import { periodesComparaison, ymd, type Filtres } from "./filtres.js";

// Onglet Statistiques de la fiche lieu (maquette fiche-lieu.html du 10/11/2026) : ce que /stats/lieux/:id
// ne donne pas. Tout est compté par soirée : journée d'exploitation de 6 h à 6 h le lendemain
// (une vente à 2 h du samedi compte pour le vendredi soir).

/** Heure de bascule d'une soirée à la suivante (à rendre réglable par lieu plus tard) */
export const HEURE_BASCULE = 6;

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

// Vraie vente : acceptée et débitée (même règle que routes/stats.ts)
const VENDUE = Prisma.sql`(a.statut = 'ACCEPTEE' AND a.moyen_paiement <> 'AUCUN' AND a.montant_ttc_cents > 0)`;
// Soirée et heure locales (Paris) d'une transaction, et d'une séance du parcours
const LOCAL_TX = Prisma.sql`(a.horodatage AT TIME ZONE 'Europe/Paris')`;
const SOIREE_TX = Prisma.sql`(${LOCAL_TX} - make_interval(hours => ${HEURE_BASCULE}::int))::date`;
const HEURE_TX = Prisma.sql`extract(hour FROM ${LOCAL_TX})::int`;
const SOIREE_P = Prisma.sql`(p.jour_local - (CASE WHEN p.heure_locale < ${HEURE_BASCULE}::int THEN 1 ELSE 0 END))`;

/** Transactions dont la soirée tombe dans la période : de du à 6 h jusqu'à au + 1 à 6 h (heure de Paris) */
const fenetreTx = (f: Filtres) => Prisma.sql`
  a.horodatage >= ((${ymd(f.du)}::date + make_time(${HEURE_BASCULE}::int, 0, 0)) AT TIME ZONE 'Europe/Paris')
  AND a.horodatage < ((${ymd(f.au)}::date + 1 + make_time(${HEURE_BASCULE}::int, 0, 0)) AT TIME ZONE 'Europe/Paris')`;
const fenetreP = (f: Filtres) =>
  Prisma.sql`p.jour_local BETWEEN ${ymd(f.du)}::date AND (${ymd(f.au)}::date + 1) AND ${SOIREE_P} BETWEEN ${ymd(f.du)}::date AND ${ymd(f.au)}::date`;

/** Filtres de la barre (gamme, module, moyen de paiement) sur les transactions, sans les cartes de test */
function filtresTx(f: Filtres, avecPaiement = true): Prisma.Sql {
  const c = [Prisma.sql`NOT a.test`];
  if (f.gammeId?.length) c.push(Prisma.sql`b.gamme_id IN (${Prisma.join(f.gammeId)})`);
  if (avecPaiement && f.typeModuleId?.length) c.push(Prisma.sql`a.type_module_id IN (${Prisma.join(f.typeModuleId)})`);
  if (avecPaiement && f.moyenPaiement?.length) c.push(Prisma.sql`a.moyen_paiement::text IN (${Prisma.join(f.moyenPaiement)})`);
  return Prisma.join(c, " AND ");
}
const filtreGammeP = (f: Filtres) => (f.gammeId?.length ? Prisma.sql`AND b.gamme_id IN (${Prisma.join(f.gammeId)})` : Prisma.empty);

export interface Indicateurs {
  soirees: number;
  caTtcCents: number;
  caHtCents: number;
  nbVentes: number;
  caParSoireeTtcCents: number | null;
  caParSoireeHtCents: number | null;
  ventesParSoiree: number | null;
  panierTtcCents: number | null;
  panierHtCents: number | null;
  /** Séances du parcours invité commencées / payées (null : pas de parcours reçu) */
  seances: number;
  seancesPayees: number;
  tauxPayees: number | null;
  refus: number;
  annulations: number;
  /** Refus et annulations sur les demandes de paiement (ventes + refus + annulations) */
  tauxRefusAnnulations: number | null;
}

const MEDIANES = ["caParSoireeTtcCents", "caParSoireeHtCents", "ventesParSoiree", "panierTtcCents", "panierHtCents", "tauxPayees", "tauxRefusAnnulations"] as const;
type CleMediane = (typeof MEDIANES)[number];

/** Médiane d'une liste (null si vide) */
export function mediane(valeurs: number[]): number | null {
  if (!valeurs.length) return null;
  const v = [...valeurs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Moins de lieux que ça dans le type : pas de médiane (elle dévoilerait le chiffre d'un autre lieu) */
export const MIN_LIEUX_COMPARAISON = 3;

export async function statsFicheLieu(lieuId: number, f: Filtres) {
  const lieu = await prisma.lieu.findUnique({
    where: { id: lieuId },
    select: { id: true, typeLieuId: true, parc: true, demo: true, typeLieu: { select: { libelle: true } } },
  });
  if (!lieu) throw new HttpError(404, "INTROUVABLE");

  // Lieux comparables : même type, même parc, hors démonstration (le lieu lui-même toujours, pour ses chiffres)
  const lieuxType = Prisma.sql`SELECT l.id FROM lieux l
    WHERE l.type_lieu_id = ${lieu.typeLieuId} AND l.parc::text = ${lieu.parc} AND (NOT l.demo OR l.id = ${lieuId})`;

  const [soirees, ventes, parcours, cases, precedente] = await Promise.all([
    // Soirées ouvertes : au moins une transaction (quel que soit son statut) ou une séance du parcours
    prisma.$queryRaw<Record<string, unknown>[]>`
      WITH s AS (
        SELECT a.lieu_id, ${SOIREE_TX} soiree
        FROM transactions a JOIN bornes b ON b.id = a.borne_id
        WHERE a.lieu_id IN (${lieuxType}) AND ${fenetreTx(f)} AND ${filtresTx(f, false)}
        UNION
        SELECT p.lieu_id, ${SOIREE_P} soiree
        FROM parcours p JOIN bornes b ON b.id = p.borne_id
        WHERE p.lieu_id IN (${lieuxType}) AND ${fenetreP(f)} ${filtreGammeP(f)}
      )
      SELECT lieu_id, extract(isodow FROM soiree)::int dow, count(*) nb FROM s GROUP BY 1, 2`,
    // Ventes, refus et annulations par lieu, sur les mêmes soirées
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT a.lieu_id,
             coalesce(sum(a.montant_ttc_cents) FILTER (WHERE ${VENDUE}), 0) ca,
             coalesce(sum(a.montant_ht_cents) FILTER (WHERE ${VENDUE}), 0) ca_ht,
             count(*) FILTER (WHERE ${VENDUE}) nb,
             count(*) FILTER (WHERE a.statut = 'REFUSEE') refus,
             count(*) FILTER (WHERE a.statut = 'ANNULEE') annul
      FROM transactions a JOIN bornes b ON b.id = a.borne_id
      WHERE a.lieu_id IN (${lieuxType}) AND ${fenetreTx(f)} AND ${filtresTx(f)}
      GROUP BY 1`,
    // Séances payées, d'après le parcours invité
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT p.lieu_id, count(*) nb, count(*) FILTER (WHERE p.paiement_statut = 'accepte') payees
      FROM parcours p JOIN bornes b ON b.id = p.borne_id
      WHERE p.lieu_id IN (${lieuxType}) AND ${fenetreP(f)} ${filtreGammeP(f)}
      GROUP BY 1`,
    // CA du lieu par soirée de la semaine et par heure
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT extract(isodow FROM ${SOIREE_TX})::int dow, ${HEURE_TX} heure,
             sum(a.montant_ttc_cents) ca, sum(a.montant_ht_cents) ca_ht, count(*) nb
      FROM transactions a JOIN bornes b ON b.id = a.borne_id
      WHERE a.lieu_id = ${lieuId} AND ${VENDUE} AND ${fenetreTx(f)} AND ${filtresTx(f)}
      GROUP BY 1, 2`,
    comparabilitePrecedente(lieuId, f),
  ]);

  // Indicateurs de chaque lieu du type
  const ids = new Set<number>([...soirees, ...ventes, ...parcours].map((r) => n(r.lieu_id)));
  const indicateurs = new Map<number, Indicateurs>();
  for (const id of ids) {
    const nbSoirees = soirees.filter((r) => n(r.lieu_id) === id).reduce((t, r) => t + n(r.nb), 0);
    const v = ventes.find((r) => n(r.lieu_id) === id);
    const p = parcours.find((r) => n(r.lieu_id) === id);
    const ca = n(v?.ca), caHt = n(v?.ca_ht), nb = n(v?.nb), refus = n(v?.refus), annul = n(v?.annul);
    const seances = n(p?.nb), payees = n(p?.payees);
    indicateurs.set(id, {
      soirees: nbSoirees,
      caTtcCents: ca,
      caHtCents: caHt,
      nbVentes: nb,
      caParSoireeTtcCents: nbSoirees ? Math.round(ca / nbSoirees) : null,
      caParSoireeHtCents: nbSoirees ? Math.round(caHt / nbSoirees) : null,
      ventesParSoiree: nbSoirees ? nb / nbSoirees : null,
      panierTtcCents: nb ? Math.round(ca / nb) : null,
      panierHtCents: nb ? Math.round(caHt / nb) : null,
      seances,
      seancesPayees: payees,
      tauxPayees: seances ? payees / seances : null,
      refus,
      annulations: annul,
      tauxRefusAnnulations: nb + refus + annul ? (refus + annul) / (nb + refus + annul) : null,
    });
  }

  // Médianes : lieux du type ouverts au moins une soirée sur la période, hors démonstration
  // (les autres lieux de démo sont déjà hors de la requête ; le lieu lui-même s'il en est un)
  const groupe = [...indicateurs.entries()].filter(([id, x]) => x.soirees > 0 && !(lieu.demo && id === lieuId)).map(([, x]) => x);
  const assez = groupe.length >= MIN_LIEUX_COMPARAISON;
  const medianes = assez
    ? (Object.fromEntries(MEDIANES.map((k) => [k, mediane(groupe.map((x) => x[k]).filter((v): v is number => v !== null))])) as Record<CleMediane, number | null>)
    : null;

  const moi = indicateurs.get(lieuId) ?? null;
  const soireesLieu = soirees.filter((r) => n(r.lieu_id) === lieuId);
  return {
    periode: { du: ymd(f.du), au: ymd(f.au) },
    heureBascule: HEURE_BASCULE,
    lieu: moi,
    // Soirées de la semaine (ISO, 1 = lundi soir) : nombre de soirées ouvertes de ce jour
    parSoir: [1, 2, 3, 4, 5, 6, 7].map((dow) => ({ jourSemaine: dow, soirees: n(soireesLieu.find((r) => n(r.dow) === dow)?.nb) })),
    // Cases soirée × heure (heure locale de la vente, 0-23)
    cases: cases.map((c) => ({ jourSemaine: n(c.dow), heure: n(c.heure), caTtcCents: n(c.ca), caHtCents: n(c.ca_ht), nbVentes: n(c.nb) })),
    precedente,
    comparaison: {
      typeLieu: lieu.typeLieu.libelle,
      /** Lieux du type retenus pour les médianes (le lieu compris, sauf s'il est de démonstration) */
      nbLieux: groupe.length,
      lieuDemo: lieu.demo,
      medianes,
    },
  };
}

/**
 * La période précédente sert-elle de comparaison ? Non si elle est vide (aucune transaction) ou partielle
 * (première borne posée sur le lieu après son début).
 */
async function comparabilitePrecedente(lieuId: number, f: Filtres) {
  const { precedente } = periodesComparaison(f);
  const [premiere, activite] = await Promise.all([
    prisma.affectationBorne.findFirst({ where: { lieuId }, orderBy: { debut: "asc" }, select: { debut: true } }),
    prisma.transaction.findFirst({
      where: { lieuId, test: false, jourLocal: { gte: precedente.du, lte: precedente.au } },
      select: { id: true },
    }),
  ]);
  const debutActivite = premiere ? localParis(premiere.debut).jour : null;
  const raison = !activite ? ("vide" as const) : debutActivite && debutActivite > precedente.du ? ("partielle" as const) : null;
  return { du: ymd(precedente.du), au: ymd(precedente.au), comparable: raison === null, raison, debutActivite: debutActivite ? ymd(debutActivite) : null };
}
