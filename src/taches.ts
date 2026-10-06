import { prisma } from "./lib/prisma.js";
import { localParis } from "./alertes/ouverture.js";
import { evaluerAlertes } from "./alertes/evaluation.js";
import { envoyerRecapitulatif, notifierAlertes } from "./alertes/notifications.js";
import { calculerReversements } from "./commissions/service.js";

const MINUTE = 60_000;
const HEURE_RECAP = 8; // récapitulatif quotidien des alertes, heure de Paris

/**
 * Tâches de fond (une seule instance de l'API suffit) :
 * - reversements des périodes terminées, toutes les heures (idempotent, périodes validées figées) ;
 * - alertes, toutes les 15 minutes, avec notifications des nouvelles alertes ;
 * - récapitulatif quotidien des alertes à 8 h.
 */
export function demarrerPlanificateur() {
  const reversements = () =>
    calculerReversements()
      .then((r) => r.calcules && console.log(`Reversements : ${r.calcules} période(s) calculée(s)`))
      .catch((err) => console.error("Calcul des reversements :", err));

  const alertes = () =>
    evaluerAlertes()
      .then(async ({ creees, resolues }) => {
        if (creees.length || resolues) console.log(`Alertes : ${creees.length} nouvelle(s), ${resolues} résolue(s)`);
        await notifierAlertes(creees);
      })
      .catch((err) => console.error("Évaluation des alertes :", err));

  let dernierRecap = 0;
  const recapitulatif = async () => {
    const { jour, minutes } = localParis(new Date());
    if (minutes < HEURE_RECAP * 60 || dernierRecap === jour.getTime()) return;
    dernierRecap = jour.getTime();
    // Après un redémarrage : déjà envoyé aujourd'hui ? (minuit à Paris ≥ jour − 2 h)
    const deja = await prisma.notificationAlerte.findFirst({
      where: { alerteId: null, envoyeLe: { gte: new Date(jour.getTime() - 2 * 3_600_000) } },
    });
    if (!deja) await envoyerRecapitulatif().catch((err) => console.error("Récapitulatif :", err));
  };

  setTimeout(() => {
    reversements();
    alertes();
  }, MINUTE);
  setInterval(reversements, 60 * MINUTE);
  setInterval(() => {
    alertes();
    recapitulatif();
  }, 15 * MINUTE);
}
