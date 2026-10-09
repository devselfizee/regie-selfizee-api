// Impact d'un événement du journal (CDC §8 : soirée spéciale, travaux, changement de prix).
import { jourOuvert, type OuvertureLieu } from "../alertes/ouverture.js";

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const plus = (d: Date, j: number) => new Date(d.getTime() + j * JOUR);
/** Au-delà, l'événement est « durable » (prix, travaux) : comparaison avant / après. */
export const DUREE_PONCTUEL_JOURS = 3;
export const FENETRE_JOURS = 28;
/** Jours ouverts observés après le début avant de conclure sur un événement durable. */
export const OBSERVATION_MIN_JOURS = 7;

export interface VentesJour {
  caCents: number;
  nbVentes: number;
}

export interface Periode {
  jours: number; // jours ouverts
  caParJourCents: number;
  ventesParJour: number;
  panierMoyenCents: number;
}

export type Impact =
  | { type: "PONCTUEL"; caCents: number; habituelCents: number; effet: number | null }
  | { type: "DURABLE"; avant: Periode; apres: Periode; effetCa: number | null; effetVentes: number | null; effetPanier: number | null }
  | { type: "EN_COURS"; joursObserves: number }
  | { type: "A_VENIR" };

const ratio = (a: number, b: number) => (b > 0 ? a / b - 1 : null);

/**
 * @param debut premier jour de l'événement (Paris), @param fin dernier jour inclus (null : durable, sans fin)
 * @param hier dernier jour complet connu
 */
export function impact(
  lieu: OuvertureLieu,
  ventes: Map<string, VentesJour>,
  depuis: Date | null,
  debut: Date,
  fin: Date | null,
  hier: Date
): Impact {
  if (debut > hier) return { type: "A_VENIR" };
  const v = (d: Date) => ventes.get(ymd(d)) ?? { caCents: 0, nbVentes: 0 };
  const utilisable = (d: Date) => (!depuis || d >= depuis) && jourOuvert(lieu, d);
  const ponctuel = fin !== null && (fin.getTime() - debut.getTime()) / JOUR < DUREE_PONCTUEL_JOURS;

  if (ponctuel) {
    // CA des jours de l'événement, comparé au même jour de la semaine des 4 semaines précédentes
    let ca = 0;
    let habituel = 0;
    for (let d = debut; d <= fin! && d <= hier; d = plus(d, 1)) {
      ca += v(d).caCents;
      const refs = [1, 2, 3, 4].map((k) => plus(d, -7 * k)).filter(utilisable);
      if (refs.length) habituel += refs.reduce((s, r) => s + v(r).caCents, 0) / refs.length;
    }
    return { type: "PONCTUEL", caCents: ca, habituelCents: Math.round(habituel), effet: ratio(ca, habituel) };
  }

  const periode = (du: Date, au: Date): Periode => {
    let jours = 0, ca = 0, nb = 0;
    for (let d = du; d <= au; d = plus(d, 1)) {
      if (!utilisable(d)) continue;
      jours++;
      ca += v(d).caCents;
      nb += v(d).nbVentes;
    }
    return {
      jours,
      caParJourCents: jours ? Math.round(ca / jours) : 0,
      ventesParJour: jours ? Math.round((nb / jours) * 10) / 10 : 0,
      panierMoyenCents: nb ? Math.round(ca / nb) : 0,
    };
  };
  const finApres = [plus(debut, FENETRE_JOURS - 1), hier, ...(fin ? [fin] : [])].reduce((a, b) => (a < b ? a : b));
  const apres = periode(debut, finApres);
  if (apres.jours < OBSERVATION_MIN_JOURS) return { type: "EN_COURS", joursObserves: apres.jours };
  const avant = periode(plus(debut, -FENETRE_JOURS), plus(debut, -1));
  return {
    type: "DURABLE",
    avant,
    apres,
    effetCa: ratio(apres.caParJourCents, avant.caParJourCents),
    effetVentes: ratio(apres.ventesParJour, avant.ventesParJour),
    effetPanier: ratio(apres.panierMoyenCents, avant.panierMoyenCents),
  };
}
