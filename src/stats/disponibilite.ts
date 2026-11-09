// Disponibilité d'une borne (CDC §5.2 : « temps en ligne, pannes ») : part du temps
// d'ouverture du lieu pendant laquelle la borne a donné signe de vie (heartbeats).
import { localParis, ouvertA, type OuvertureLieu } from "../alertes/ouverture.js";

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

  // Parcours de l'ouverture par pas de 5 min (retour de Sébastien : le taux et les coupures doivent se recouper).
  // Un pas est « en ligne » si la borne a donné signe de vie il y a 15 min au plus. Avant, le taux comptait
  // 5 min par heartbeat, et une borne allumée en retard ou éteinte tôt perdait du taux sans aucune coupure affichée.
  // Désormais tout temps d'ouverture sans signal est une coupure : en journée, à l'ouverture comme à la fermeture.
  const hb = heartbeats.map((h) => h.getTime());
  let k = 0; // index du premier heartbeat après l'instant courant
  const pas = INTERVALLE_HEARTBEAT_MIN * MINUTE;
  const debut = Math.max(du.getTime() - 2 * 3_600_000, presence.debut.getTime()); // minuit Paris ≥ minuit UTC − 2 h
  const fin = Math.min(au.getTime() + JOUR + 2 * 3_600_000, presence.fin?.getTime() ?? Infinity);
  let pasAttendus = 0;
  let pasEnLigne = 0;
  let coupures = 0;
  let plusLongue = 0;
  let enCours = 0; // minutes de la coupure en cours
  const cloreCoupure = () => {
    if (enCours > 0) {
      coupures++;
      plusLongue = Math.max(plusLongue, enCours);
    }
    enCours = 0;
  };
  for (let t = Math.ceil(debut / pas) * pas; t < fin; t += pas) {
    const instant = new Date(t);
    const jour = localParis(instant).jour;
    if (jour < du || jour > au || !ouvertA(lieu, instant)) {
      cloreCoupure(); // une fermeture sépare deux coupures
      continue;
    }
    pasAttendus++;
    while (k < hb.length && hb[k] <= t) k++;
    const dernier = k > 0 ? hb[k - 1] : -Infinity;
    if (t - dernier <= SEUIL_COUPURE_MIN * MINUTE) {
      pasEnLigne++;
      cloreCoupure();
    } else enCours += INTERVALLE_HEARTBEAT_MIN;
  }
  cloreCoupure();

  const minutesAttendues = pasAttendus * INTERVALLE_HEARTBEAT_MIN;
  const minutesEnLigne = pasEnLigne * INTERVALLE_HEARTBEAT_MIN;
  return {
    minutesAttendues,
    minutesEnLigne,
    taux: minutesAttendues ? minutesEnLigne / minutesAttendues : null,
    coupures,
    plusLongueCoupureMin: Math.round(plusLongue),
  };
}
