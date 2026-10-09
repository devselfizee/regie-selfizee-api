// Prévision du CA d'un lieu (CDC V3 « pilotage »). Fonction pure et explicable :
// 1. niveau : CA moyen du même jour de la semaine sur les 8 dernières semaines (jours ouverts) ;
// 2. saisonnalité : si l'année précédente est connue, le niveau est corrigé du rapport
//    « CA N-1 autour du jour prévu / CA N-1 sur la période de référence » ;
// 3. jours fermés (saison, fermetures, jours sans horaire) : 0.
// La fourchette (≈ 80 %) vient de la dispersion observée des jours de la semaine.
import { jourOuvert, type OuvertureLieu } from "../alertes/ouverture.js";
import { SEUIL_PLUIE_MM, type ContexteJour, type Effet, type Effets } from "../calendrier/contexte.js";

const JOUR = 86_400_000;
export const SEMAINES_REFERENCE = 8;
const Z80 = 1.28;
/** Jours ouverts consécutifs sans vente au-delà desquels on considère l'activité arrêtée. */
export const JOURS_ARRET = 7;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const plus = (d: Date, j: number) => new Date(d.getTime() + j * JOUR);
const dow = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1;

export interface JourPrevu {
  jour: string;
  realiseCents: number | null; // null : jour à venir
  prevuCents: number; // 0 si fermé
  ouvert: boolean;
  /** Correction calendrier / météo appliquée (1 = aucune) et ses raisons */
  correction?: { facteur: number; raisons: string[] };
}

/** Effet mesuré sur au moins ce nombre de jours pour corriger une prévision. */
export const EFFECTIF_MIN_CORRECTION = 5;

export interface Calendrier {
  contexte: (jour: string) => ContexteJour;
  effets: Effets;
}

export interface Prevision {
  du: string;
  au: string;
  realiseCents: number;
  restantCents: number; // CA attendu d'ici la fin de la période
  totalCents: number;
  basseCents: number;
  hauteCents: number;
  joursOuvertsRestants: number;
  /** Historique suffisant (au moins 3 semaines d'ouverture) : sinon, prévision indicative */
  fiable: boolean;
  correctionSaisonniere: number | null; // facteur moyen appliqué, null sans N-1
  /** Plus aucune vente depuis ce jour malgré l'ouverture (saison finie non saisie, borne en panne) : rien n'est prévu */
  arretDepuis: string | null;
  jours: JourPrevu[];
}

const moyenne = (x: number[]) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0);
const variance = (x: number[]) => {
  if (x.length < 2) return 0;
  const m = moyenne(x);
  return x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
};

/**
 * @param historique CA TTC par jour (ymd → centimes), jours sans vente absents
 * @param depuis premier jour où le lieu était équipé (avant : pas d'historique)
 * @param aujourdhui jour courant (Paris) : réalisé jusqu'à ce jour inclus, le jour même étant complété par la prévision
 */
export function prevoir(
  lieu: OuvertureLieu,
  historique: Map<string, number>,
  depuis: Date | null,
  du: Date,
  au: Date,
  aujourdhui: Date,
  calendrier?: Calendrier
): Prevision {
  const ca = (d: Date) => historique.get(ymd(d)) ?? 0;
  const equipe = (d: Date) => !depuis || d >= depuis;

  // Échantillons par jour de la semaine : jours ouverts et équipés des 8 semaines avant aujourd'hui
  const echantillons = new Map<number, number[]>();
  const tous: number[] = [];
  for (let i = 1; i <= SEMAINES_REFERENCE * 7; i++) {
    const d = plus(aujourdhui, -i);
    if (!equipe(d) || !jourOuvert(lieu, d)) continue;
    const v = ca(d);
    tous.push(v);
    echantillons.set(dow(d), [...(echantillons.get(dow(d)) ?? []), v]);
  }
  const niveau = (d: Date) => {
    const e = echantillons.get(dow(d)) ?? [];
    return e.length >= 2 ? { m: moyenne(e), v: variance(e) } : { m: moyenne(tous), v: variance(tous) };
  };

  // Saisonnalité N-1 : CA moyen par jour ouvert sur ±3 jours autour du jour prévu (un an plus tôt, même jour de semaine),
  // rapporté au CA moyen par jour ouvert de la période de référence un an plus tôt
  const refN1: number[] = [];
  for (let i = 1; i <= SEMAINES_REFERENCE * 7; i++) {
    const d = plus(aujourdhui, -i - 364);
    if (equipe(d) && jourOuvert(lieu, d)) refN1.push(ca(d));
  }
  const baseN1 = moyenne(refN1);
  const avecN1 = refN1.length >= 14 && baseN1 > 0;
  const facteur = (d: Date) => {
    if (!avecN1) return 1;
    const autour: number[] = [];
    for (let k = -3; k <= 3; k++) {
      const x = plus(d, k - 364);
      if (equipe(x) && jourOuvert(lieu, x)) autour.push(ca(x));
    }
    if (autour.length < 3) return 1;
    return Math.min(3, Math.max(0.3, moyenne(autour) / baseN1));
  };

  // Correction calendrier / météo d'après les effets mesurés pour ce lieu. Le niveau de référence
  // contient déjà une part p de jours concernés : facteur = (1 + e si le jour l'est) / (1 + p × e)
  const utilisable = (e: Effet) => (e.effet !== null && e.n >= EFFECTIF_MIN_CORRECTION ? e.effet : null);
  const joursReference: ContexteJour[] = [];
  if (calendrier)
    for (let i = 1; i <= SEMAINES_REFERENCE * 7; i++) {
      const d = plus(aujourdhui, -i);
      if (equipe(d) && jourOuvert(lieu, d)) joursReference.push(calendrier.contexte(ymd(d)));
    }
  const part = (f: (c: ContexteJour) => boolean | null) => {
    const connus = joursReference.map(f).filter((x): x is boolean => x !== null);
    return connus.length ? connus.filter(Boolean).length / connus.length : null;
  };
  const pluvieux = (c: ContexteJour) => (c.meteo?.precipitationMm == null ? null : c.meteo.precipitationMm >= SEUIL_PLUIE_MM);
  const criteres = calendrier
    ? [
        { e: utilisable(calendrier.effets.feries), p: part((c) => !!c.ferie), dans: (c: ContexteJour) => !!c.ferie, libelle: (c: ContexteJour) => `férié (${c.ferie})` },
        // Les vacances ne sont corrigées que sans N-1 : la saisonnalité de l'an dernier les contient déjà
        ...(avecN1 ? [] : [{ e: utilisable(calendrier.effets.vacances), p: part((c) => !!c.vacances), dans: (c: ContexteJour) => !!c.vacances, libelle: () => "vacances scolaires" }]),
        { e: utilisable(calendrier.effets.pluie), p: part(pluvieux), dans: pluvieux, libelle: () => "pluie prévue", hors: "temps sec prévu" },
      ]
    : [];
  const correction = (d: Date) => {
    if (!calendrier) return { facteur: 1, raisons: [] as string[] };
    const c = calendrier.contexte(ymd(d));
    let facteur = 1;
    const raisons: string[] = [];
    for (const k of criteres) {
      const dans = k.dans(c);
      if (k.e === null || k.p === null || dans === null) continue; // effet non mesuré, ou météo pas encore prévue
      const x = (dans ? 1 + k.e : 1) / (1 + k.p * k.e);
      facteur *= x;
      if (dans) raisons.push(`${k.libelle(c)} ${k.e > 0 ? "+" : ""}${Math.round(k.e * 100)} %`);
      else if ("hors" in k && k.hors && Math.abs(x - 1) >= 0.03) raisons.push(k.hors);
    }
    facteur = Math.min(2, Math.max(0.5, facteur));
    return { facteur: Math.round(facteur * 100) / 100, raisons };
  };

  // Arrêt : JOURS_ARRET jours ouverts d'affilée sans vente jusqu'à hier
  let sansVente = 0;
  let arretDepuis: Date | null = null;
  for (let d = plus(aujourdhui, -1); equipe(d) && d > plus(aujourdhui, -90); d = plus(d, -1)) {
    if (!jourOuvert(lieu, d)) continue;
    if (ca(d) > 0) break;
    sansVente++;
    arretDepuis = d;
  }
  const arret = sansVente >= JOURS_ARRET && tous.some((v) => v > 0);

  const jours: JourPrevu[] = [];
  let realise = 0;
  let restant = 0;
  let varianceRestante = 0;
  let joursOuvertsRestants = 0;
  const facteurs: number[] = [];
  for (let d = du; d <= au; d = plus(d, 1)) {
    const ouvert = jourOuvert(lieu, d);
    const passe = d < aujourdhui;
    const r = d <= aujourdhui ? ca(d) : null;
    let prevu = 0;
    let corr: JourPrevu["correction"];
    if (ouvert && !passe && !arret) {
      const { m, v } = niveau(d);
      corr = correction(d);
      const f = facteur(d) * corr.facteur;
      facteurs.push(facteur(d));
      // Aujourd'hui : on ne prévoit que ce qui manque par rapport au réalisé
      prevu = Math.max(0, m * f - (r ?? 0));
      varianceRestante += v * f * f;
      joursOuvertsRestants++;
    }
    if (r !== null) realise += r;
    restant += prevu;
    jours.push({ jour: ymd(d), realiseCents: r, prevuCents: Math.round(prevu), ouvert, ...(corr && corr.facteur !== 1 ? { correction: corr } : {}) });
  }
  const ecart = Z80 * Math.sqrt(varianceRestante);
  return {
    du: ymd(du),
    au: ymd(au),
    realiseCents: realise,
    restantCents: Math.round(restant),
    totalCents: Math.round(realise + restant),
    basseCents: Math.round(realise + Math.max(0, restant - ecart)),
    hauteCents: Math.round(realise + restant + ecart),
    joursOuvertsRestants,
    fiable: tous.length >= 21,
    correctionSaisonniere: avecN1 && facteurs.length ? Math.round(moyenne(facteurs) * 100) / 100 : null,
    arretDepuis: arret && arretDepuis ? ymd(arretDepuis) : null,
    jours,
  };
}

export type Atteinte =
  | { statut: "ATTEINT"; jour: string } // déjà dépassé avec le réalisé
  | { statut: "PREVU"; jour: string } // dépassé d'après la prévision
  | { statut: "NON_ATTEINT"; manqueCents: number }; // pas d'ici la fin de la période (prévision centrale)

/**
 * Jour où la base cumulée dépasse le seuil.
 * @param avantCents base déjà acquise avant la période (seuil cumulé depuis la date d'effet)
 * @param ratioBase base de calcul / CA TTC (HT, net des remboursements)
 */
export function dateAtteinte(p: Prevision, avantCents: number, seuilCents: number, ratioBase = 1): Atteinte {
  let realise = avantCents;
  let total = avantCents;
  let prevu: string | null = total >= seuilCents ? p.du : null;
  if (realise >= seuilCents) return { statut: "ATTEINT", jour: p.du };
  for (const j of p.jours) {
    realise += (j.realiseCents ?? 0) * ratioBase;
    total += ((j.realiseCents ?? 0) + j.prevuCents) * ratioBase;
    if (realise >= seuilCents) return { statut: "ATTEINT", jour: j.jour };
    if (!prevu && total >= seuilCents) prevu = j.jour;
  }
  return prevu ? { statut: "PREVU", jour: prevu } : { statut: "NON_ATTEINT", manqueCents: Math.round(seuilCents - total) };
}
