import type { BaseCalcul } from "@prisma/client";

// Apporteurs d'affaires (demande du 17/11/2026) : un % des ventes du lieu apporté, point mensuel.
// Calcul pur, sans base : les routes lui donnent les ventes agrégées par mois (agg_jour).

export interface RegleApport {
  tauxBp: number; // 500 = 5 %
  base: BaseCalcul;
  netRemboursements: boolean;
  dateDebut: Date; // minuit UTC (colonne @db.Date)
  dateFin: Date | null;
}

export interface VentesMois {
  caTtcCents: number;
  caHtCents: number;
  rembourseTtcCents: number;
  rembourseHtCents: number;
  nbVentes: number;
}

const JOUR_MS = 86_400_000;
const premierDuMois = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const moisSuivant = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
export const cleMois = (d: Date) => d.toISOString().slice(0, 7); // "2026-10"

/** Premier et dernier jour commissionnés d'un mois pour une règle (null : le mois est hors contrat) */
export function joursCommissionnes(regle: RegleApport, mois: Date, aujourdhui: Date): { du: Date; au: Date } | null {
  const debut = premierDuMois(mois);
  const finMois = new Date(moisSuivant(debut).getTime() - JOUR_MS);
  const du = regle.dateDebut > debut ? regle.dateDebut : debut;
  let au = finMois < aujourdhui ? finMois : aujourdhui;
  if (regle.dateFin && regle.dateFin < au) au = regle.dateFin;
  return au < du ? null : { du, au };
}

/** Mois couverts par une règle, du mois de sa date de début au mois courant (ou à sa fin), le plus récent en premier */
export function moisDeLaRegle(regle: RegleApport, aujourdhui: Date): Date[] {
  const res: Date[] = [];
  const dernier = premierDuMois(regle.dateFin && regle.dateFin < aujourdhui ? regle.dateFin : aujourdhui);
  for (let m = premierDuMois(regle.dateDebut); m <= dernier && res.length < 600; m = moisSuivant(m)) res.push(m);
  return res.reverse();
}

/** Base de calcul (TTC ou HT, nette des remboursements si demandé) et commission du mois, en centimes */
export function commissionDuMois(regle: RegleApport, v: VentesMois): { baseCents: number; commissionCents: number } {
  const ca = regle.base === "HT" ? v.caHtCents : v.caTtcCents;
  const remb = regle.netRemboursements ? (regle.base === "HT" ? v.rembourseHtCents : v.rembourseTtcCents) : 0;
  const baseCents = Math.max(0, ca - remb);
  return { baseCents, commissionCents: Math.round((baseCents * regle.tauxBp) / 10_000) };
}

/** « octobre 2026 » */
export function libelleMois(mois: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(mois);
}

/** « 5 % », « 7,5 % » */
export const libelleTaux = (tauxBp: number) => `${(tauxBp / 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;

export interface LigneLieu {
  lieuId: number;
  enseigne: string;
  ville: string | null;
  tauxBp: number;
  baseCents: number;
  commissionCents: number;
  nbVentes: number;
  /** Jours commissionnés dans le mois, s'ils ne couvrent pas tout le mois (début ou fin de contrat) */
  du?: string;
  au?: string;
}

export interface MoisApport {
  mois: string; // "2026-10"
  libelle: string;
  enCours: boolean;
  baseCents: number;
  commissionCents: number;
  nbVentes: number;
  lieux: LigneLieu[];
}

export interface TableauApport {
  mois: MoisApport[];
  /** Commission du dernier mois terminé, de l'année en cours, et depuis le début ; CA (base) de l'année en cours */
  totaux: { moisPrecedentCents: number; anneeCents: number; totalCents: number; baseAnneeCents: number; nbLieux: number };
}

/**
 * Tableau mensuel d'un apporteur : pour chaque règle (un lieu), les ventes par mois lui sont données ;
 * un mois sans vente vaut zéro (le lieu reste listé tant que le contrat court).
 */
export function tableauApport(
  regles: (RegleApport & { lieuId: number; enseigne: string; ville: string | null })[],
  ventes: Map<string, VentesMois>, // clé `${lieuId}:${YYYY-MM}`
  aujourdhui: Date
): TableauApport {
  const parMois = new Map<string, MoisApport>();
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  for (const r of regles) {
    for (const mois of moisDeLaRegle(r, aujourdhui)) {
      const jours = joursCommissionnes(r, mois, aujourdhui);
      if (!jours) continue;
      const cle = cleMois(mois);
      const v = ventes.get(`${r.lieuId}:${cle}`) ?? { caTtcCents: 0, caHtCents: 0, rembourseTtcCents: 0, rembourseHtCents: 0, nbVentes: 0 };
      const c = commissionDuMois(r, v);
      const m = parMois.get(cle) ?? { mois: cle, libelle: libelleMois(mois), enCours: cleMois(aujourdhui) === cle, baseCents: 0, commissionCents: 0, nbVentes: 0, lieux: [] };
      // Mois entier : du 1er à la fin du mois, ou jusqu'à aujourd'hui pour le mois en cours ; sinon on précise les jours
      const moisEntier = jours.du.getTime() === mois.getTime() && (jours.au.getTime() === moisSuivant(mois).getTime() - JOUR_MS || jours.au.getTime() === aujourdhui.getTime());
      m.lieux.push({ lieuId: r.lieuId, enseigne: r.enseigne, ville: r.ville, tauxBp: r.tauxBp, ...c, nbVentes: v.nbVentes, ...(moisEntier ? {} : { du: ymd(jours.du), au: ymd(jours.au) }) });
      m.baseCents += c.baseCents;
      m.commissionCents += c.commissionCents;
      m.nbVentes += v.nbVentes;
      parMois.set(cle, m);
    }
  }
  const mois = [...parMois.values()].sort((a, b) => (a.mois < b.mois ? 1 : -1));
  for (const m of mois) m.lieux.sort((a, b) => a.enseigne.localeCompare(b.enseigne, "fr"));
  const annee = cleMois(aujourdhui).slice(0, 4);
  const termines = mois.filter((m) => !m.enCours);
  return {
    mois,
    totaux: {
      moisPrecedentCents: termines[0]?.commissionCents ?? 0,
      anneeCents: mois.filter((m) => m.mois.startsWith(annee)).reduce((s, m) => s + m.commissionCents, 0),
      baseAnneeCents: mois.filter((m) => m.mois.startsWith(annee)).reduce((s, m) => s + m.baseCents, 0),
      totalCents: mois.reduce((s, m) => s + m.commissionCents, 0),
      nbLieux: new Set(regles.map((r) => r.lieuId)).size,
    },
  };
}
