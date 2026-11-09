import type { Alerte, NiveauAlerte, TypeAlerte } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { envoyerEmail, envoyerSms } from "../lib/envoi.js";

// Notifications des alertes (CDC §7) : e-mail et/ou SMS selon le niveau, plus un
// récapitulatif quotidien. E-mails par Mailjet, SMS par SMSEnvoi (comme le CRM) ;
// sans identifiants, les envois sont seulement journalisés.

export const LIBELLES: Record<TypeAlerte, string> = {
  BAISSE_CA: "Baisse de CA",
  ZERO_VENTE: "Zéro vente inhabituel",
  BORNE_MUETTE: "Borne muette",
  TAUX_REFUS: "Taux de refus élevé",
  PIC_SUSPECT: "Pic suspect",
  VENTE_HORS_HORAIRES: "Vente hors horaires",
  CONSOMMABLES: "Consommables",
  BORNE_NON_AFFECTEE: "Borne non affectée",
  ECART_RAPPROCHEMENT: "Écart de rapprochement",
};

/** Canaux par niveau : les INFO n'arrivent que dans le récapitulatif quotidien. */
const CANAUX: Record<NiveauAlerte, ("EMAIL" | "SMS")[]> = {
  INFO: [],
  WARNING: ["EMAIL"],
  CRITIQUE: ["EMAIL", "SMS"],
};

const COMMERCIALES: TypeAlerte[] = ["BAISSE_CA", "ZERO_VENTE", "PIC_SUSPECT", "VENTE_HORS_HORAIRES"];

/**
 * Qui prévenir (page Utilisateurs) : les abonnés aux e-mails des alertes, et pour une alerte de vente le commercial
 * responsable du lieu (e-mail) ; les abonnés aux SMS pour les alertes critiques. Plus aucun choix par rôle.
 */
async function destinataires(a: Pick<Alerte, "type" | "lieuId">) {
  const abonnes = await prisma.user.findMany({ where: { isActive: true, OR: [{ alertesEmail: true }, { alertesSms: true }] } });
  const liste = abonnes.map((u) => ({ ...u, parEmail: u.alertesEmail }));
  if (a.lieuId && COMMERCIALES.includes(a.type)) {
    const lieu = await prisma.lieu.findUnique({ where: { id: a.lieuId }, include: { commercial: true } });
    const c = lieu?.commercial;
    if (c?.isActive) {
      const deja = liste.find((u) => u.id === c.id);
      if (deja) deja.parEmail = true;
      else liste.push({ ...c, parEmail: true });
    }
  }
  return liste;
}

const APP_URL = () => (process.env.APP_URL ?? "").replace(/\/+$/, "");
const echapper = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Notifie les alertes nouvellement créées, selon leur niveau. Chaque envoi est tracé. */
export async function notifierAlertes(alertes: Alerte[]) {
  for (const a of alertes) {
    const canaux = CANAUX[a.niveau];
    if (!canaux.length) continue;
    const lien = APP_URL() ? `${APP_URL()}/alertes` : null;
    const sujet = `[${a.niveau === "CRITIQUE" ? "CRITIQUE" : "Alerte"}] ${LIBELLES[a.type]} — ${a.message.split(" : ")[0].split(" (")[0]}`;
    const html = `<p><strong>${echapper(LIBELLES[a.type])}</strong></p><p>${echapper(a.message)}</p>${
      lien ? `<p><a href="${lien}">Voir les alertes sur la plateforme</a></p>` : ""
    }`;

    for (const u of await destinataires(a)) {
      if (canaux.includes("EMAIL") && u.parEmail) {
        const erreur = await envoyerEmail(u.email, sujet, html).catch((e: Error) => e.message);
        await prisma.notificationAlerte.create({ data: { alerteId: a.id, canal: "EMAIL", destinataire: u.email, envoyeLe: erreur ? null : new Date(), erreur } });
      }
      // SMS : seulement aux personnes désignées (page Utilisateurs) et qui ont un numéro
      if (canaux.includes("SMS") && u.alertesSms && u.telephone) {
        const erreur = await envoyerSms(u.telephone, `Régie Selfizee — ${LIBELLES[a.type]} : ${a.message}`).catch((e: Error) => e.message);
        await prisma.notificationAlerte.create({ data: { alerteId: a.id, canal: "SMS", destinataire: u.telephone, envoyeLe: erreur ? null : new Date(), erreur } });
      }
    }
  }
}

/** Récapitulatif quotidien des alertes ouvertes, envoyé aux abonnés aux e-mails des alertes. */
export async function envoyerRecapitulatif(maintenant = new Date()) {
  const ouvertes = await prisma.alerte.findMany({
    where: { statut: { in: ["NOUVELLE", "PRISE_EN_CHARGE"] } },
    orderBy: [{ niveau: "desc" }, { detecteeLe: "desc" }],
  });
  const depuisHier = ouvertes.filter((a) => a.detecteeLe.getTime() > maintenant.getTime() - 86_400_000).length;
  const ligne = (a: Alerte) =>
    `<li><strong>${a.niveau === "CRITIQUE" ? "■ Critique" : a.niveau === "WARNING" ? "▲ Warning" : "● Info"}</strong> — ${echapper(LIBELLES[a.type])} : ${echapper(a.message)}${a.statut === "PRISE_EN_CHARGE" ? " <em>(prise en charge)</em>" : ""}</li>`;
  const html = ouvertes.length
    ? `<p>${ouvertes.length} alerte(s) ouverte(s), dont ${depuisHier} nouvelle(s) depuis hier.</p><ul>${ouvertes.map(ligne).join("")}</ul>${
        APP_URL() ? `<p><a href="${APP_URL()}/alertes">Ouvrir la plateforme</a></p>` : ""
      }`
    : "<p>Aucune alerte ouverte. Tout va bien.</p>";
  const sujet = `Régie Selfizee — récapitulatif : ${ouvertes.length} alerte(s) ouverte(s)`;

  // Aux abonnés aux e-mails des alertes (page Utilisateurs)
  const admins = await prisma.user.findMany({ where: { isActive: true, alertesEmail: true, email: { not: "dev@local" } } });
  for (const u of admins) {
    const erreur = await envoyerEmail(u.email, sujet, html).catch((e: Error) => e.message);
    await prisma.notificationAlerte.create({ data: { alerteId: null, canal: "EMAIL", destinataire: u.email, envoyeLe: erreur ? null : new Date(), erreur } });
  }
  return { ouvertes: ouvertes.length, destinataires: admins.length };
}
