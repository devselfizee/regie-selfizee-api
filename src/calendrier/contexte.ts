// Effet du calendrier et de la météo sur les ventes (CDC V3).
// Chaque jour ouvert reçoit un indice : son CA rapporté au CA moyen du même jour de la
// semaine sur les 4 semaines avant et après (jours ouverts, hors fériés). La saison et le
// jour de la semaine s'annulent : on compare ensuite la moyenne des indices par catégorie.
import { prisma } from "../lib/prisma.js";
import { jourOuvert, type OuvertureLieu } from "../alertes/ouverture.js";
import { debutsEquipement, historiques } from "../previsions/service.js";
import { feriesEntre, vacancesEntre, zoneScolaire, type ZoneScolaire } from "./calendrier.js";

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const plus = (d: Date, j: number) => new Date(d.getTime() + j * JOUR);
const moyenne = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;

/** Pluie au-delà de laquelle un jour compte comme « pluvieux » (mm). */
export const SEUIL_PLUIE_MM = 1;
/** Effectif minimal d'une catégorie pour afficher un effet. */
export const EFFECTIF_MIN = 3;
export const TRANCHES_TEMPERATURE = [
  { libelle: "moins de 10 °C", max: 10 },
  { libelle: "10 à 18 °C", max: 18 },
  { libelle: "18 à 25 °C", max: 25 },
  { libelle: "25 °C et plus", max: Infinity },
] as const;

export interface MeteoDuJour {
  tempMax: number | null;
  precipitationMm: number | null;
  codeWmo: number | null;
  prevision: boolean;
}

export interface ContexteJour {
  ferie: string | null;
  vacances: string | null;
  meteo: MeteoDuJour | null;
}

export interface Indice {
  jour: string;
  indice: number;
  contexte: ContexteJour;
}

/**
 * Indices des jours ouverts de [du, au] (jours terminés seulement).
 * @param historique CA TTC par jour (ymd → centimes)
 * @param depuis premier jour où le lieu était équipé
 * @param jusqua dernier jour connu (hier) : les références au-delà sont ignorées
 */
export function indicesJournaliers(
  lieu: OuvertureLieu,
  historique: Map<string, number>,
  depuis: Date | null,
  du: Date,
  au: Date,
  jusqua: Date,
  contexte: (jour: string) => ContexteJour
): Indice[] {
  const ca = (d: Date) => historique.get(ymd(d)) ?? 0;
  const utilisable = (d: Date) => (!depuis || d >= depuis) && d <= jusqua && jourOuvert(lieu, d);
  const fin = au < jusqua ? au : jusqua;
  const resultat: Indice[] = [];
  for (let d = du; d <= fin; d = plus(d, 1)) {
    if (!utilisable(d)) continue;
    const references: number[] = [];
    for (const k of [-4, -3, -2, -1, 1, 2, 3, 4]) {
      const r = plus(d, 7 * k);
      if (utilisable(r) && !contexte(ymd(r)).ferie) references.push(ca(r));
    }
    if (references.length < 2) continue;
    const m = moyenne(references);
    if (m <= 0) continue;
    resultat.push({ jour: ymd(d), indice: ca(d) / m, contexte: contexte(ymd(d)) });
  }
  return resultat;
}

export interface Effet {
  /** Écart de CA par rapport aux autres jours (0,25 = +25 %), null si effectif insuffisant */
  effet: number | null;
  n: number;
}

/** Effet d'une catégorie : moyenne de ses indices / moyenne des autres jours − 1. */
function effet(dans: number[], hors: number[]): Effet {
  if (dans.length < EFFECTIF_MIN || hors.length < EFFECTIF_MIN) return { effet: null, n: dans.length };
  const h = moyenne(hors);
  return { effet: h > 0 ? moyenne(dans) / h - 1 : null, n: dans.length };
}

export function effets(indices: Indice[]) {
  const partition = (f: (i: Indice) => boolean | null) => {
    const dans: number[] = [];
    const hors: number[] = [];
    for (const i of indices) {
      const r = f(i);
      if (r === null) continue;
      (r ? dans : hors).push(i.indice);
    }
    return effet(dans, hors);
  };
  const avecMeteo = indices.filter((i) => i.contexte.meteo?.tempMax != null);
  return {
    jours: indices.length,
    feries: partition((i) => !!i.contexte.ferie),
    vacances: partition((i) => !!i.contexte.vacances),
    pluie: partition((i) => (i.contexte.meteo?.precipitationMm == null ? null : i.contexte.meteo.precipitationMm >= SEUIL_PLUIE_MM)),
    temperatures: TRANCHES_TEMPERATURE.map((t, k) => {
      const min = k ? TRANCHES_TEMPERATURE[k - 1].max : -Infinity;
      const dans = avecMeteo.filter((i) => i.contexte.meteo!.tempMax! >= min && i.contexte.meteo!.tempMax! < t.max).map((i) => i.indice);
      const hors = avecMeteo.filter((i) => !(i.contexte.meteo!.tempMax! >= min && i.contexte.meteo!.tempMax! < t.max)).map((i) => i.indice);
      return { tranche: t.libelle, ...effet(dans, hors) };
    }),
  };
}

export type Effets = ReturnType<typeof effets>;

/** Fériés, vacances (zone du lieu) et météo du lieu, jour par jour. */
export async function chargerContexte(lieux: { id: number; codePostal: string | null }[], du: Date, au: Date) {
  const feries = feriesEntre(du, au);
  const zones = new Map(lieux.map((l) => [l.id, zoneScolaire(l.codePostal)]));
  const vacances = new Map<ZoneScolaire, Map<string, string>>();
  for (const z of new Set([...zones.values()].filter((z): z is ZoneScolaire => !!z))) vacances.set(z, await vacancesEntre(z, du, au));
  const meteo = await prisma.meteoJour.findMany({ where: { lieuId: { in: lieux.map((l) => l.id) }, jour: { gte: du, lte: au } } });
  const meteoParLieu = new Map<number, Map<string, MeteoDuJour>>();
  for (const m of meteo) {
    if (!meteoParLieu.has(m.lieuId)) meteoParLieu.set(m.lieuId, new Map());
    meteoParLieu.get(m.lieuId)!.set(ymd(m.jour), { tempMax: m.tempMax, precipitationMm: m.precipitationMm, codeWmo: m.codeWmo, prevision: m.prevision });
  }
  return (lieuId: number) => {
    const zone = zones.get(lieuId) ?? null;
    return {
      zone,
      jour: (j: string): ContexteJour => ({
        ferie: feries.get(j) ?? null,
        vacances: zone ? vacances.get(zone)?.get(j) ?? null : null,
        meteo: meteoParLieu.get(lieuId)?.get(j) ?? null,
      }),
    };
  };
}

/** Indices de plusieurs lieux sur une période (pour un lieu ou pour l'analyse par segment). */
export async function indicesDesLieux(
  lieux: ({ id: number; codePostal: string | null } & OuvertureLieu)[],
  du: Date,
  au: Date,
  hier: Date
) {
  const ids = lieux.map((l) => l.id);
  // Références jusqu'à 4 semaines autour de la période
  const [hist, debuts, contexte] = await Promise.all([historiques(ids, plus(du, -28)), debutsEquipement(ids), chargerContexte(lieux, plus(du, -28), plus(au, 28))]);
  return new Map(
    lieux.map((l) => [l.id, indicesJournaliers(l, hist.get(l.id) ?? new Map(), debuts.get(l.id) ?? null, du, au, hier, contexte(l.id).jour)])
  );
}
