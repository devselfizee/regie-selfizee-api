import { calculerReversements } from "./service.js";

const UNE_HEURE = 60 * 60_000;

/**
 * Calcul automatique des reversements des périodes terminées (CDC §6 « calcul
 * automatique en fin de période »). Toutes les heures : le calcul est idempotent
 * et ne touche jamais une période validée. Une seule instance de l'API suffit.
 */
export function demarrerPlanificateur() {
  const tourner = () =>
    calculerReversements()
      .then((r) => r.calcules && console.log(`Reversements : ${r.calcules} période(s) calculée(s)`))
      .catch((err) => console.error("Calcul des reversements :", err));
  setTimeout(tourner, 60_000);
  setInterval(tourner, UNE_HEURE);
}
