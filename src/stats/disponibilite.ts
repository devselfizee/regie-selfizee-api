// Disponibilité d'une borne (CDC §5.2 : « temps en ligne, pannes ») : part du temps
// d'ouverture du lieu pendant laquelle la borne a donné signe de vie (heartbeats).
import { localParis, ouvertA, type OuvertureLieu } from "../alertes/ouverture.js";
import { minutesOuverture } from "./segments.js";

const JOUR = 86_400_000;
const MINUTE = 60_000;
/** Intervalle des heartbeats (doc de synchronisation) : chacun couvre 5 minutes. */
export const INTERVALLE_HEARTBEAT_MIN = 5;
/** Silence au-delà duquel on parle de coupure (3 heartbeats manqués). */
const SEUIL_COUPURE_MIN = 15;

export interface Disponibilite {
  minutesAttendues: number;
  minutesEnLigne: number;
  taux: number | null;
  coupures: number;
  plusLongueCoupureMin: number;
}

/**
 * @param presence période où la borne était dans ce lieu (affectation)
 * @param heartbeats horodatages des heartbeats de la borne, triés
 */
export function disponibilite(
  lieu: OuvertureLieu,
  presence: { debut: Date; fin: Date | null },
  du: Date,
  au: Date,
  heartbeats: Date[],
  maintenant = new Date()
): Disponibilite {
  // Jours terminés seulement : la journée en cours fausserait le taux
  const hier = new Date(localParis(maintenant).jour.getTime() - JOUR);
  if (au > hier) au = hier;

  // Temps d'ouverture attendu : jours de la période où la borne était installée
  let minutesAttendues = 0;
  for (let t = du.getTime(); t <= au.getTime(); t += JOUR) {
    const debutJour = new Date(t);
    const finJour = new Date(t + JOUR);
    if (presence.debut >= finJour || (presence.fin && presence.fin <= debutJour)) continue;
    minutesAttendues += minutesOuverture(lieu, debutJour);
  }

  // Heartbeats reçus pendant l'ouverture, et silences entre deux heartbeats
  const utiles = heartbeats.filter((h) => {
    const jour = localParis(h).jour;
    return jour >= du && jour <= au && h >= presence.debut && (!presence.fin || h < presence.fin) && ouvertA(lieu, h);
  });
  let coupures = 0;
  let plusLongue = 0;
  for (let i = 1; i < utiles.length; i++) {
    const ecartMin = (utiles[i].getTime() - utiles[i - 1].getTime()) / MINUTE;
    // Un silence qui enjambe une fermeture n'est pas une coupure : on vérifie le milieu
    const milieu = new Date((utiles[i].getTime() + utiles[i - 1].getTime()) / 2);
    if (ecartMin > SEUIL_COUPURE_MIN && ouvertA(lieu, milieu)) {
      coupures++;
      plusLongue = Math.max(plusLongue, ecartMin);
    }
  }

  const minutesEnLigne = Math.min(minutesAttendues, utiles.length * INTERVALLE_HEARTBEAT_MIN);
  return {
    minutesAttendues,
    minutesEnLigne,
    taux: minutesAttendues ? minutesEnLigne / minutesAttendues : null,
    coupures,
    plusLongueCoupureMin: Math.round(plusLongue),
  };
}
