import type { EvenementMarketing } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

// Calendrier marketing (demande de Sébastien, 02/11/2026) : occurrences des temps forts sur une période.
// Un événement annuel revient chaque année aux mêmes jour et mois (sa durée est gardée).

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface OccurrenceMarketing {
  id: number;
  nom: string;
  du: string;
  au: string;
  annuel: boolean;
}

/** Occurrences des événements qui touchent [du, au] (dates en minuit UTC), triées par date */
export function occurrences(evenements: EvenementMarketing[], du: Date, au: Date): OccurrenceMarketing[] {
  const r: OccurrenceMarketing[] = [];
  for (const e of evenements) {
    const duree = e.fin.getTime() - e.debut.getTime();
    const annees = e.annuel ? Array.from({ length: au.getUTCFullYear() - du.getUTCFullYear() + 2 }, (_, i) => du.getUTCFullYear() - 1 + i) : [e.debut.getUTCFullYear()];
    for (const a of annees) {
      const debut = e.annuel ? new Date(Date.UTC(a, e.debut.getUTCMonth(), e.debut.getUTCDate())) : e.debut;
      const fin = new Date(debut.getTime() + duree);
      if (fin >= du && debut <= au) r.push({ id: e.id, nom: e.nom, du: ymd(debut), au: ymd(fin), annuel: e.annuel });
    }
  }
  return r.sort((a, b) => a.du.localeCompare(b.du));
}

export async function occurrencesEntre(du: Date, au: Date) {
  return occurrences(await prisma.evenementMarketing.findMany(), du, au);
}

export const finJour = (d: Date) => new Date(d.getTime() + JOUR - 1);
