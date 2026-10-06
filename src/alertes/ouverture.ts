// Le lieu est-il ouvert ? Sert à ne pas lever de fausses alertes (CDC §7) :
// hors saison, fermeture exceptionnelle ou en dehors des horaires, une borne
// sans vente ou sans signal n'est pas anormale.
import { TZDate } from "@date-fns/tz";
import { FUSEAU_METIER } from "../lib/temps.js";

export interface OuvertureLieu {
  saisonnalite: "ANNUEL" | "SAISONNIER";
  horaires: { jourSemaine: number; ouverture: Date; fermeture: Date }[]; // heures locales stockées en 1970-01-01THH:MMZ
  saisons: { debut: Date; fin: Date }[];
  fermetures: { debut: Date; fin: Date }[];
}

// Sans horaires renseignés : créneau par défaut, pour ne pas alerter en pleine nuit
const DEFAUT = { ouverture: 10 * 60, fermeture: 22 * 60 };

const minutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
const jourMs = 86_400_000;

/** Date locale (minuit UTC), jour ISO (1 = lundi) et minutes depuis minuit, à Paris. */
export function localParis(instant: Date) {
  const l = new TZDate(instant, FUSEAU_METIER);
  const jour = new Date(Date.UTC(l.getFullYear(), l.getMonth(), l.getDate()));
  return { jour, isoDow: ((l.getDay() + 6) % 7) + 1, minutes: l.getHours() * 60 + l.getMinutes() };
}

const dansPeriode = (jour: Date, p: { debut: Date; fin: Date }) => jour >= p.debut && jour <= p.fin;
const isoDow = (jour: Date) => ((jour.getUTCDay() + 6) % 7) + 1;

/** Le lieu ouvre-t-il ce jour-là (saison, fermetures, jour d'ouverture) ? */
export function jourOuvert(l: OuvertureLieu, jour: Date): boolean {
  // Saisonnier sans saison saisie : on ne peut pas savoir, on le considère ouvert (la fiche le signale)
  if (l.saisonnalite === "SAISONNIER" && l.saisons.length && !l.saisons.some((s) => dansPeriode(jour, s))) return false;
  if (l.fermetures.some((f) => dansPeriode(jour, f))) return false;
  if (!l.horaires.length) return true;
  return l.horaires.some((h) => h.jourSemaine === isoDow(jour));
}

/** Le lieu est-il ouvert à cet instant ? Gère les créneaux qui passent minuit (23:00 → 05:00). */
export function ouvertA(l: OuvertureLieu, instant: Date): boolean {
  const { jour, isoDow: dow, minutes: m } = localParis(instant);
  const veille = new Date(jour.getTime() - jourMs);

  if (!l.horaires.length) {
    return jourOuvert(l, jour) && m >= DEFAUT.ouverture && m < DEFAUT.fermeture;
  }
  for (const h of l.horaires) {
    const o = minutes(h.ouverture);
    const f = minutes(h.fermeture);
    const nuit = f <= o; // fermeture le lendemain
    // Créneau commencé aujourd'hui
    if (h.jourSemaine === dow && jourOuvert(l, jour) && m >= o && (nuit || m < f)) return true;
    // Créneau de nuit commencé la veille
    if (nuit && h.jourSemaine === isoDow(veille) && jourOuvert(l, veille) && m < f) return true;
  }
  return false;
}

/** Nombre de jours ouverts entre deux dates incluses. */
export function joursOuverts(l: OuvertureLieu, du: Date, au: Date): number {
  let n = 0;
  for (let t = du.getTime(); t <= au.getTime(); t += jourMs) if (jourOuvert(l, new Date(t))) n++;
  return n;
}
