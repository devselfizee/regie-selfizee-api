// Analyse par segment (CDC §5.3) : indicateurs normalisés par lieu et croisement
// de deux critères de la fiche lieu (moyenne, médiane, nombre de lieux par case).
import { jourOuvert, type OuvertureLieu } from "../alertes/ouverture.js";

const JOUR = 86_400_000;
const minutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
const isoDow = (jour: Date) => ((jour.getUTCDay() + 6) % 7) + 1;
// Sans horaires renseignés : même créneau par défaut que les alertes (10 h – 22 h)
const DUREE_DEFAUT_MIN = 12 * 60;

/** Minutes d'ouverture d'un jour (créneaux qui commencent ce jour-là, nuit comprise). */
export function minutesOuverture(l: OuvertureLieu, jour: Date): number {
  if (!jourOuvert(l, jour)) return 0;
  if (!l.horaires.length) return DUREE_DEFAUT_MIN;
  return l.horaires
    .filter((h) => h.jourSemaine === isoDow(jour))
    .reduce((s, h) => {
      const o = minutes(h.ouverture);
      const f = minutes(h.fermeture);
      return s + (f > o ? f - o : f + 24 * 60 - o);
    }, 0);
}

/**
 * Jours d'ouverture effectifs : le lieu est ouvert (fiche) ET une borne y est installée.
 * Un lieu équipé en cours de période n'est pas pénalisé.
 */
export function joursEffectifs(
  l: OuvertureLieu,
  affectations: { debut: Date; fin: Date | null }[],
  du: Date,
  au: Date
): { jours: number; minutes: number } {
  let jours = 0;
  let total = 0;
  for (let t = du.getTime(); t <= au.getTime(); t += JOUR) {
    const debutJour = new Date(t);
    const finJour = new Date(t + JOUR);
    const equipe = affectations.some((a) => a.debut < finJour && (!a.fin || a.fin > debutJour));
    if (!equipe) continue;
    const m = minutesOuverture(l, debutJour);
    if (m > 0) {
      jours++;
      total += m;
    }
  }
  return { jours, minutes: total };
}

/** Heure de fermeture la plus tardive (en heures depuis minuit, 26 = 2 h du matin). */
export function fermetureLaPlusTardive(l: OuvertureLieu): number | null {
  if (!l.horaires.length) return null;
  return Math.max(
    ...l.horaires.map((h) => {
      const o = minutes(h.ouverture);
      const f = minutes(h.fermeture);
      return (f > o ? f : f + 24 * 60) / 60;
    })
  );
}

export const tranchesFermeture = (h: number | null) =>
  h === null ? null : h <= 20 ? "Jusqu'à 20 h" : h <= 23 ? "20 h – 23 h" : h <= 26 ? "23 h – 2 h" : "Après 2 h";
export const ORDRE_FERMETURE = ["Jusqu'à 20 h", "20 h – 23 h", "23 h – 2 h", "Après 2 h"];

export const tranchesCapacite = (c: number | null) =>
  c === null ? null : c < 200 ? "< 200" : c < 500 ? "200 – 500" : c < 1000 ? "500 – 1 000" : c < 3000 ? "1 000 – 3 000" : "≥ 3 000";
export const ORDRE_CAPACITE = ["< 200", "200 – 500", "500 – 1 000", "1 000 – 3 000", "≥ 3 000"];

export function mediane(valeurs: number[]): number | null {
  if (!valeurs.length) return null;
  const t = [...valeurs].sort((a, b) => a - b);
  const m = Math.floor(t.length / 2);
  return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2;
}

export const moyenne = (valeurs: number[]) => (valeurs.length ? valeurs.reduce((s, v) => s + v, 0) / valeurs.length : null);

export interface Groupe<T> {
  x: string;
  y: string;
  lieux: T[];
}

/**
 * Croise deux critères : chaque lieu tombe dans une case par combinaison de ses valeurs
 * (un lieu à plusieurs clientèles compte dans chacune). Sans critère Y : une seule ligne.
 */
export function croiser<T>(lieux: T[], x: (l: T) => string[], y: ((l: T) => string[]) | null): Groupe<T>[] {
  const cases = new Map<string, Groupe<T>>();
  for (const l of lieux) {
    for (const vx of x(l)) {
      for (const vy of y ? y(l) : ["Tous"]) {
        const cle = `${vx}\u0000${vy}`;
        if (!cases.has(cle)) cases.set(cle, { x: vx, y: vy, lieux: [] });
        cases.get(cle)!.lieux.push(l);
      }
    }
  }
  return [...cases.values()];
}
