import { prisma } from "./lib/prisma.js";
import { localParis } from "./alertes/ouverture.js";
import { evaluerAlertes } from "./alertes/evaluation.js";
import { envoyerRecapitulatif, notifierAlertes } from "./alertes/notifications.js";
import { calculerReversements } from "./commissions/service.js";
import { completerCodesPostaux, synchroniserVacances } from "./calendrier/calendrier.js";
import { synchroniserMeteo } from "./calendrier/meteo.js";
import { antennesConfigure, synchroniserVillesPrincipales } from "./antennes/villes.js";
import { purgerMedias, telechargerEnAttente } from "./synchro-pikcloud/telechargement.js";
import { purgerSouvenir, rattraperLivraisons } from "./souvenir/donnees.js";
import { purgerJournal } from "./config-evenement/programmeBorne.js";
import { envoyerEnAttente } from "./souvenir/envois.js";

const MINUTE = 60_000;
const HEURE_RECAP = 8; // récapitulatif quotidien des alertes, heure de Paris

/**
 * Tâches de fond (une seule instance de l'API suffit) :
 * - reversements des périodes terminées, toutes les heures (idempotent, périodes validées figées) ;
 * - alertes, toutes les 15 minutes, avec notifications des nouvelles alertes ;
 * - récapitulatif quotidien des alertes à 8 h ;
 * - vacances scolaires, météo des lieux et villes principales de l'application Antennes, toutes les 6 heures
 *   (DONNEES_EXTERNES=0 pour couper) ;
 * - médias PikCloud : téléchargement des fichiers en attente toutes les minutes (rattrapage, le webhook
 *   déclenche déjà une passe à chaque réception), purge de rétention toutes les heures (MEDIAS_RETENTION_JOURS) ;
 * - page souvenir : livraisons en attente de la photo débloquées et mails envoyés (Mailjet) toutes les minutes,
 *   données des invités effacées à 90 jours toutes les heures (CDC page souvenir § 6, § 9.2).
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

  const donneesExternes = async () => {
    if (process.env.DONNEES_EXTERNES === "0") return;
    await completerCodesPostaux().catch((err) => console.error("Codes postaux :", err));
    await synchroniserVacances().catch((err) => console.error("Vacances scolaires :", err));
    const m = await synchroniserMeteo().catch((err) => (console.error("Météo :", err), null));
    if (m?.erreurs.length) console.error("Météo :", m.erreurs.join(" ; "));
    if (antennesConfigure()) {
      const v = await synchroniserVillesPrincipales().catch((err) => (console.error("Villes principales (Antennes) :", err), null));
      if (v && v.creees + v.majees + v.rapprochees + v.desactivees) console.log("Villes principales (Antennes) :", JSON.stringify(v));
    }
  };

  const medias = () =>
    telechargerEnAttente()
      .then((b) => b.traites && console.log(`Médias PikCloud : ${b.reussis} fichier(s) téléchargé(s), ${b.echoues} échec(s)`))
      .catch((err) => console.error("Téléchargement des médias :", err));
  const purge = () =>
    purgerMedias()
      .then((n) => n && console.log(`Médias PikCloud : ${n} média(s) purgé(s) (rétention)`))
      .catch((err) => console.error("Purge des médias :", err));

  const livraisons = () =>
    rattraperLivraisons()
      .then((n) => n && console.log(`Page souvenir : ${n} livraison(s) débloquée(s), photo arrivée`))
      .then(() => envoyerEnAttente())
      .then((b) => b.envoyes + b.echecs && console.log(`Page souvenir : ${b.envoyes} mail(s) envoyé(s), ${b.echecs} échec(s)`))
      .catch((err) => console.error("Livraisons de la page souvenir :", err));
  const purgeSouvenir = () =>
    purgerSouvenir()
      .then((r) => r.anonymisees + r.liens && console.log(`Page souvenir : ${r.anonymisees} inscription(s) anonymisée(s), ${r.liens} lien(s) supprimé(s)`))
      .catch((err) => console.error("Purge de la page souvenir :", err));
  // Journal des téléchargements d'événements : 180 jours gardés
  const purgeJournal = () =>
    purgerJournal()
      .then((n) => n && console.log(`Journal des téléchargements : ${n} ligne(s) de plus de 180 jours supprimée(s)`))
      .catch((err) => console.error("Purge du journal des téléchargements :", err));

  setTimeout(() => {
    purgeSouvenir();
    reversements();
    alertes();
    donneesExternes();
    purge();
  }, MINUTE);
  setTimeout(medias, 10_000);
  setInterval(medias, MINUTE);
  setInterval(livraisons, MINUTE);
  setInterval(purgeSouvenir, 60 * MINUTE);
  setInterval(purgeJournal, 6 * 60 * MINUTE);
  setInterval(purge, 60 * MINUTE);
  setInterval(donneesExternes, 6 * 60 * MINUTE);
  setInterval(reversements, 60 * MINUTE);
  setInterval(() => {
    alertes();
    recapitulatif();
  }, 15 * MINUTE);
}
