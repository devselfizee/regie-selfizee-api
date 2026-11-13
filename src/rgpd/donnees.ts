import { prisma } from "../lib/prisma.js";
import { emailConfigure, envoyerEmail } from "../lib/envoi.js";
import { HttpError } from "../lib/http.js";
import { mediasAEffacer, purgerMedia } from "../synchro-pikcloud/telechargement.js";
import { journaliser, oublier } from "../souvenir/donnees.js";
import { expediteur } from "../souvenir/envois.js";
import { affichable, urlSignee } from "../souvenir/seance.js";
import { extensionDuChemin } from "../lib/stockage.js";
import { ecrireJetonAcces, VALIDITE_JOURS } from "./jeton.js";
import { lireModele, listeAdresses, rendreModele } from "./modeles.js";

// Données personnelles tenues par la Régie pour une adresse e-mail, telles que la plateforme RGPD (rgpd.orkessi.com)
// les montre, les exporte, les corrige et les efface. Contrat repris de l'API RGPD du booth (UserDataReport) : un
// « événement » par code d'événement de la Régie, un « enregistrement » par inscription « Recevoir mes photos » de la
// page souvenir (CDC page souvenir § 9.3), avec la photo de la séance.

const FUSEAU = "Europe/Paris";
/** Durée des URLs signées des photos montrées sur la plateforme. */
const VALIDITE_PHOTOS_S = 2 * 3600;
/** Au-delà, la liste est tronquée (une adresse n'a en pratique que quelques inscriptions). */
const MAX_INSCRIPTIONS = 500;

export const urlPlateforme = () => (process.env.RGPD_URL || "https://rgpd.orkessi.com").replace(/\/+$/, "");

/** « 04-11-2026 21:42 », comme le booth. */
function dateAffichee(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

const LIBELLES_LOT: Record<string, string> = { free: "Tirage offert", pct50: "-50 % sur le tirage", pct30: "-30 % sur le tirage" };
const OUI_NON = ["Oui", "Non"];
const ouiNon = (v: boolean) => (v ? "Oui" : "Non");

// ─── Lecture ───

const selection = {
  id: true,
  codeEvent: true,
  photoUuid: true,
  email: true,
  prenom: true,
  optinLieu: true,
  optinSelfizee: true,
  lieuId: true,
  createdAt: true,
  evenement: { select: { nom: true } },
  lieu: { select: { enseigne: true, ville: true } },
  carte: { select: { lot: true, reveleeLe: true, codeRemise: { select: { code: true } } } },
} as const;

async function inscriptionsDe(email: string) {
  return prisma.souvenirInscription.findMany({ where: { email }, select: selection, orderBy: { createdAt: "desc" }, take: MAX_INSCRIPTIONS });
}
type Inscription = Awaited<ReturnType<typeof inscriptionsDe>>[number];

/** « La Ruche (Trégueux) — Halloween » */
function nomEvenement(i: Pick<Inscription, "codeEvent" | "evenement" | "lieu">): string {
  const lieu = i.lieu ? (i.lieu.ville ? `${i.lieu.enseigne} (${i.lieu.ville})` : i.lieu.enseigne) : `Événement ${i.codeEvent}`;
  return i.evenement?.nom ? `${lieu} — ${i.evenement.nom}` : lieu;
}

export interface Champ {
  label: string;
  value: string;
  /** Champ modifiable : son nom, renvoyé par la plateforme à l'édition */
  contactId?: string;
  options?: string[];
}

/** Les données d'une inscription, dans l'ordre montré. Prénom et consentements sont modifiables. */
function champs(i: Inscription): Champ[] {
  const lieu = i.lieu?.enseigne ?? "ce lieu";
  const c: Champ[] = [
    { label: "Adresse e-mail", value: i.email ?? "" },
    { label: "Prénom", value: i.prenom ?? "", contactId: "prenom" },
    { label: `Recevoir les offres de ${lieu}`, value: ouiNon(i.optinLieu), contactId: "optinLieu", options: OUI_NON },
    { label: "Recevoir les actualités de Selfizee", value: ouiNon(i.optinSelfizee), contactId: "optinSelfizee", options: OUI_NON },
  ];
  if (i.carte?.reveleeLe && i.carte.lot !== "none") {
    c.push({ label: "Carte à gratter", value: `${LIBELLES_LOT[i.carte.lot] ?? i.carte.lot}${i.carte.codeRemise ? ` (code ${i.carte.codeRemise.code})` : ""}` });
  }
  return c;
}

/** Photo de chaque séance (la photo fixe d'abord, sinon le GIF) : `${code}:${photoUuid}` → uuid du média. */
async function photosDesSeances(ins: Pick<Inscription, "codeEvent" | "photoUuid">[]): Promise<Map<string, string>> {
  const seances = [...new Map(ins.map((i) => [`${i.codeEvent}:${i.photoUuid}`, { codeEvent: i.codeEvent, photoUuid: i.photoUuid }])).values()];
  if (!seances.length) return new Map();
  const medias = await prisma.media.findMany({
    where: { OR: seances, mediaStatut: "TELECHARGE" },
    select: { uuid: true, codeEvent: true, photoUuid: true, mediaStatut: true, mediaChemin: true },
    orderBy: { id: "asc" },
  });
  const choisies = new Map<string, { uuid: string; gif: boolean }>();
  for (const m of medias) {
    if (!affichable(m)) continue;
    const k = `${m.codeEvent}:${m.photoUuid}`;
    const gif = extensionDuChemin(m.mediaChemin!) === "gif";
    const deja = choisies.get(k);
    if (!deja || (deja.gif && !gif)) choisies.set(k, { uuid: m.uuid, gif });
  }
  return new Map([...choisies].map(([k, v]) => [k, v.uuid]));
}

export interface Rapport {
  email: string;
  expired: false;
  mediaCount: number;
  eventCount: number;
  events: { id: string; name: string; records: { id: string; date: string; type: "photo"; photo: string | null; photoFull: string | null; fields: Champ[] }[] }[];
}

/** Tout ce que la Régie tient pour cette adresse, groupé par événement (le plus récent d'abord). */
export async function rapport(email: string, base: string): Promise<Rapport> {
  const ins = await inscriptionsDe(email);
  const photos = await photosDesSeances(ins);
  const evenements = new Map<string, Rapport["events"][number]>();
  for (const i of ins) {
    const uuid = photos.get(`${i.codeEvent}:${i.photoUuid}`);
    const url = uuid ? urlSignee(base, `/fichiers/${uuid}`, VALIDITE_PHOTOS_S) : null;
    const e = evenements.get(i.codeEvent) ?? { id: i.codeEvent, name: nomEvenement(i), records: [] };
    e.records.push({ id: i.id, date: dateAffichee(i.createdAt), type: "photo", photo: url ? `${url}&l=500` : null, photoFull: url, fields: champs(i) });
    evenements.set(i.codeEvent, e);
  }
  const events = [...evenements.values()];
  return { email, expired: false, mediaCount: ins.length, eventCount: events.length, events };
}

/** Export (droit à la portabilité) : une ligne par donnée, CSV pour Excel (point-virgule, BOM). */
export async function exporterCsv(email: string): Promise<string> {
  const ins = await inscriptionsDe(email);
  // Une valeur qui commence comme une formule (= + - @) est précédée d'une apostrophe : Excel l'affiche sans la calculer
  const cellule = (brut: string) => {
    const v = /^[=+\-@\t\r]/.test(brut) ? `'${brut}` : brut;
    return /[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lignes = [["Événement", "Code de l'événement", "Enregistré le", "Donnée", "Valeur"]];
  for (const i of ins) {
    const commun = [nomEvenement(i), i.codeEvent, dateAffichee(i.createdAt)];
    for (const c of champs(i)) lignes.push([...commun, c.label, c.value]);
    lignes.push([...commun, "Identifiant de la séance photo", i.photoUuid]);
  }
  return "﻿" + lignes.map((l) => l.map(cellule).join(";")).join("\r\n") + "\r\n";
}

// ─── Demande du lien d'accès ───

/**
 * Envoie le lien d'accès (7 jours) si la Régie connaît l'adresse. Renvoie le motif d'un envoi raté (journalisé par
 * la route), null sinon ; l'appelant répond pareil dans tous les cas (on ne dit pas si l'adresse est connue).
 */
export async function envoyerLienAcces(email: string, maintenant = Date.now()): Promise<string | null> {
  const connue = await prisma.souvenirInscription.findFirst({ where: { email }, select: { id: true } });
  if (!connue) return null;
  const lien = `${urlPlateforme()}/e/inf/${ecrireJetonAcces(email, maintenant)}`;
  const m = await lireModele("RGPD_ACCES");
  const plateforme = urlPlateforme();
  const mail = rendreModele(
    m,
    {
      email: { texte: email },
      validite: { texte: `${VALIDITE_JOURS} jours` },
      plateforme: { texte: plateforme, html: `<a href="${plateforme}" style="color:#ed195f;">${plateforme.replace(/^https?:\/\//, "")}</a>` },
    },
    { url: lien, libelle: "Accéder à mes données" }
  );
  return envoyerEmail(email, mail.sujet, mail.html, [], { expediteur: expediteur(), texte: mail.texte });
}

// ─── Suppression (droit à l'effacement) ───

export type Cible = "photo" | "data" | "both";

/** L'inscription de cette adresse, sinon 404 (on ne dit pas si elle existe pour une autre adresse). */
async function inscriptionDe(email: string, id: unknown): Promise<Inscription> {
  if (typeof id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(404, "INTROUVABLE", "Cet enregistrement n'existe plus.");
  const i = await prisma.souvenirInscription.findFirst({ where: { id, email }, select: selection });
  if (!i) throw new HttpError(404, "INTROUVABLE", "Cet enregistrement n'existe plus.");
  return i;
}

/** D'autres personnes ont-elles demandé la photo de cette séance (photo de groupe) ? */
const autresDemandeurs = (i: Pick<Inscription, "id" | "codeEvent" | "photoUuid">) =>
  prisma.souvenirInscription.count({ where: { codeEvent: i.codeEvent, photoUuid: i.photoUuid, email: { not: null }, id: { not: i.id } } });

async function effacerPhotos(i: Pick<Inscription, "codeEvent" | "photoUuid">) {
  const medias = await prisma.media.findMany({
    where: mediasAEffacer(i.codeEvent, i.photoUuid),
    select: { id: true, mediaChemin: true, vignetteChemin: true },
  });
  for (const m of medias) await purgerMedia(m, "RGPD");
}

export interface BilanSuppression {
  deleted: number;
  /** Photos gardées parce que d'autres personnes les ont demandées (photo de groupe) */
  photoKept: number;
}

/**
 * Un enregistrement : « both » efface l'e-mail, le prénom, les traces techniques et la photo (sauf si d'autres
 * personnes l'ont demandée) ; « data » efface le prénom, les traces et retire les consentements, l'adresse reste (elle
 * donne accès à la photo) ; « photo » efface la photo seule, refusé si d'autres personnes l'ont demandée.
 */
export async function supprimerEnregistrement(email: string, id: unknown, cible: Cible, maintenant = Date.now()): Promise<BilanSuppression> {
  const i = await inscriptionDe(email, id);
  const j = { code: i.codeEvent, photoUuid: i.photoUuid };
  let bilan: BilanSuppression;
  let detail: string;
  if (cible === "both") {
    const r = await oublier(i.id, maintenant);
    // Déjà effacée par une demande simultanée : celle-là a répondu et notifié
    if (!r) throw new HttpError(404, "INTROUVABLE", "Cet enregistrement n'existe plus.");
    bilan = { deleted: 1, photoKept: r.photosEffacees ? 0 : 1 };
    detail = bilan.photoKept ? "données effacées ; photo gardée (demandée par d'autres personnes)" : "photo et données effacées";
  } else if (cible === "data") {
    await prisma.souvenirInscription.update({
      where: { id: i.id },
      data: { prenom: null, ipTronquee: null, userAgent: null, optinLieu: false, optinSelfizee: false },
    });
    await journaliser("data_deleted", j, i.lieuId, { photos: false });
    bilan = { deleted: 1, photoKept: 0 };
    detail = "prénom et traces techniques effacés, consentements retirés";
  } else {
    if ((await autresDemandeurs(i)) > 0) {
      throw new HttpError(409, "PHOTO_PARTAGEE", "D'autres personnes ont demandé cette photo : elle ne peut pas être supprimée d'ici. Écrivez à dpo@selfizee.fr.");
    }
    await effacerPhotos(i);
    await journaliser("data_deleted", j, i.lieuId, { photos: true });
    bilan = { deleted: 1, photoKept: 0 };
    detail = "photo effacée";
  }
  notifierEnArrierePlan("suppression", email, [nomEvenement(i)], [`${dateAffichee(i.createdAt)} — ${detail}`], maintenant);
  return bilan;
}

/** Tout un événement : chaque inscription de l'adresse est effacée comme « both ». */
export async function supprimerEvenement(email: string, code: unknown, maintenant = Date.now()): Promise<BilanSuppression> {
  if (typeof code !== "string" || !/^[A-Z0-9]{3,8}$/i.test(code)) throw new HttpError(404, "INTROUVABLE", "Cet événement n'existe plus.");
  const ins = await prisma.souvenirInscription.findMany({ where: { email, codeEvent: code.toUpperCase() }, select: selection });
  if (!ins.length) throw new HttpError(404, "INTROUVABLE", "Cet événement n'existe plus.");
  const bilan: BilanSuppression = { deleted: 0, photoKept: 0 };
  const details: string[] = [];
  for (const i of ins) {
    const r = await oublier(i.id, maintenant);
    if (!r) continue;
    bilan.deleted++;
    if (!r.photosEffacees) bilan.photoKept++;
    details.push(`${dateAffichee(i.createdAt)} — ${r.photosEffacees ? "photo et données effacées" : "données effacées ; photo gardée (demandée par d'autres personnes)"}`);
  }
  notifierEnArrierePlan("suppression", email, [nomEvenement(ins[0])], details, maintenant);
  return bilan;
}

// ─── Modification (droit de rectification) ───

export interface ChampModifie {
  contactId: string;
  value: string;
}

/** Prénom et consentements : seuls champs modifiables. Renvoie le nombre de champs réellement changés. */
export async function modifierEnregistrement(email: string, id: unknown, champsRecus: ChampModifie[], maintenant = Date.now()): Promise<number> {
  const i = await inscriptionDe(email, id);
  const data: { prenom?: string | null; optinLieu?: boolean; optinSelfizee?: boolean } = {};
  const details: string[] = [];
  // Map et non objet : « __proto__ » ou « constructor » ne sont pas des champs
  const avant = new Map(champs(i).filter((c) => c.contactId).map((c) => [c.contactId!, c]));
  const vus = new Set<string>();
  for (const { contactId, value } of champsRecus) {
    const c = avant.get(contactId);
    if (!c) throw new HttpError(400, "CHAMP_NON_MODIFIABLE", "Ce champ ne peut pas être modifié.");
    if (vus.has(contactId)) continue; // champ envoyé deux fois : le premier compte
    vus.add(contactId);
    const v = value.trim();
    if (contactId === "prenom") {
      if (v.length > 60) throw new HttpError(400, "VALEUR_INVALIDE", "Le prénom est trop long (60 caractères au plus).");
      if (v === (i.prenom ?? "")) continue;
      data.prenom = v || null;
    } else {
      if (!OUI_NON.includes(v)) throw new HttpError(400, "VALEUR_INVALIDE", "Répondez Oui ou Non.");
      if (v === c.value) continue;
      data[contactId as "optinLieu" | "optinSelfizee"] = v === "Oui";
    }
    details.push(`${c.label} : « ${c.value || "—"} » → « ${v || "—"} »`);
  }
  if (!details.length) return 0;
  await prisma.souvenirInscription.update({ where: { id: i.id }, data });
  const optins: Record<string, boolean> = {};
  if (data.optinLieu !== undefined) optins.optinLieu = data.optinLieu;
  if (data.optinSelfizee !== undefined) optins.optinSelfizee = data.optinSelfizee;
  await journaliser("data_updated", { code: i.codeEvent, photoUuid: i.photoUuid }, i.lieuId, optins);
  notifierEnArrierePlan("modification", email, [nomEvenement(i)], [`${dateAffichee(i.createdAt)}`, ...details], maintenant);
  return details.length;
}

// ─── Notification interne ───

/** Mail « RGPD : suppression / modification » aux destinataires réglés dans la Régie ; rien sans destinataire. */
export async function notifier(action: "suppression" | "modification", email: string, evenements: string[], details: string[], maintenant = Date.now()): Promise<string | null> {
  const m = await lireModele("RGPD_NOTIFICATION");
  const destinataires = listeAdresses(m.destinataires);
  if (!destinataires.length || !emailConfigure()) return null;
  const date = new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, dateStyle: "long", timeStyle: "short" }).format(new Date(maintenant));
  const mail = rendreModele(m, {
    action: { texte: action },
    email: { texte: email },
    evenements: { texte: evenements.join(", ") },
    date: { texte: date },
    details: { texte: details.join("\n"), html: details.map((d) => d.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)).join("<br>") },
  });
  return envoyerEmail(destinataires, mail.sujet, mail.html, [], { expediteur: expediteur(), texte: mail.texte });
}

function notifierEnArrierePlan(...a: Parameters<typeof notifier>) {
  notifier(...a).then(
    (e) => e && console.error("Notification RGPD :", e),
    (err) => console.error("Notification RGPD :", err)
  );
}
