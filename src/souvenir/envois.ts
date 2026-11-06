import sharp from "sharp";
import type { SouvenirInscription } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { emailConfigure, envoyerEmail, type PieceJointe } from "../lib/envoi.js";
import { extensionDuChemin, lireBuffer, mimeDe } from "../lib/stockage.js";
import { lienPageSouvenir } from "../config-evenement/generation.js";
import { adressePage, basePublique } from "./base.js";
import { jetonOubli } from "./jeton.js";
import { mailCode, mailIntrouvable, mailLivraison, mailToutes, raisonSeance, type LotGagne, type Pied } from "./mails.js";
import { affichable, avecTests, CONSERVATION_JOURS, contexteSeance, evenementAffiche, lireSeanceSouvenir, urlSignee } from "./seance.js";
import { REBOND } from "./donnees.js";

// Envoi des mails de la page souvenir par Mailjet (src/lib/envoi.ts, le fournisseur de la Régie) :
// - mail 1, livraison des photos, pour chaque livraison « à envoyer » (inscription, renvoi, photo arrivée) ;
// - mail 2, code gagné, à la révélation d'une carte gagnante ;
// - « on n'a pas retrouvé ta photo », 24 h après une inscription dont la photo n'est jamais arrivée ;
// - mail 3, lien « Toutes tes photos », envoyé directement à la demande (envoyerLienParMail).
// Une passe part après chaque action de l'invité, et le planificateur en relance une chaque minute (rattrapage).
// Sans MAILJET_API_KEY / MAILJET_API_SECRET, rien ne part : les livraisons restent « à envoyer ».
// Les rebonds durs arrivent par le webhook Mailjet (routes/webhookMailjet.ts) et passent la livraison en « échec ».

const MINUTE = 60_000;
const JOUR = 24 * 60 * MINUTE;
/** Images d'un mail (aperçu, photos d'exemple) et liens suivis : valables aussi longtemps que les photos. */
const VALIDITE_MAIL_S = CONSERVATION_JOURS * 86_400;
/** Essais d'envoi refusés par le fournisseur avant l'échec : espacés de 5, 20, 45, 80, 125 minutes. */
const ESSAIS_MAX = 6;
const delaiEssai = (tentatives: number) => tentatives * tentatives * 5 * MINUTE;
/** Pièces jointes du mail 1 : 10 Mo visés (§ 6.1) ; au-delà, GIF réduit à 400 px, puis retiré. */
const PJ_MAX = 10 * 1024 * 1024;
const PAR_PASSE = 25;

/**
 * Expéditeur des mails de la page souvenir : SENDER_SELFIZEE, « photos@selfizee.fr » ou « Selfizee <photos@selfizee.fr> »
 * (adresse validée dans Mailjet). Nom par défaut : Selfizee.
 */
export function expediteur(valeur = process.env.SENDER_SELFIZEE): { email: string; nom: string } {
  const v = valeur?.trim() ?? "";
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(v);
  if (m) return { email: m[2], nom: m[1].replace(/^"|"$/g, "").trim() || "Selfizee" };
  if (/^[^<>\s]+@[^<>\s]+$/.test(v)) return { email: v, nom: "Selfizee" };
  return { email: "photos@selfizee.fr", nom: "Selfizee" };
}

/** Identifiants renvoyés par Mailjet dans ses événements : l = livraison (mail 1), c = carte (mail 2). */
export const idSuivi = (type: "l" | "c", id: bigint | number) => `souvenir-${type}-${id}`;

export interface Bilan {
  envoyes: number;
  echecs: number;
}

// ─── Liens des mails ───

const SELFIZEE = { instagram: "https://www.instagram.com/selfizee/", tiktok: "https://www.tiktok.com/@selfizee" };

/** Compte Instagram / TikTok saisi dans la Régie (« @lieu » ou une adresse) → lien ; le compte Selfizee à défaut. */
export function compteReseau(reseau: "instagram" | "tiktok", valeur: string | null | undefined): string {
  const v = valeur?.trim();
  if (v && /^https:\/\/(www\.)?(instagram\.com|tiktok\.com)\//i.test(v)) return v;
  const nom = v?.replace(/^@/, "");
  if (!nom || !/^[A-Za-z0-9._]{1,40}$/.test(nom)) return SELFIZEE[reseau];
  return reseau === "instagram" ? `https://www.instagram.com/${nom}/` : `https://www.tiktok.com/@${nom}`;
}

export type CibleSuivie = "avis" | "instagram" | "tiktok";

/** Lien suivi d'un mail (/souvenir/v1/r/…, CDC § 4.8) ; le lien direct si l'adresse publique de l'API est inconnue. */
function lienSuivi(cible: CibleSuivie, inscriptionId: string, direct: string): string {
  const base = basePublique();
  return base ? urlSignee(base, `/r/${cible}/${inscriptionId}`, VALIDITE_MAIL_S) : direct;
}

function pied(raison: string, inscriptionId?: string): Pied {
  const page = adressePage();
  return { logo: `${page}/selfizee.png`, viePrivee: `${page}/vie-privee`, raison, ...(inscriptionId ? { oubli: `${page}/forget/${jetonOubli(inscriptionId)}` } : {}) };
}

const ILLUSTRATIONS_PAGE = [1, 2, 3].map((n) => `/illustrations/illus-${n}.jpg`);

// ─── Mail 1 : livraison ───

type Preparation = { mail: ReturnType<typeof mailLivraison>; pj: PieceJointe[] } | { attente: true } | { refus: string };

/** Nom de fichier : selfizee-la-ruche-2026-10-19.jpg */
const nomFichier = (lieu: string, date: Date, ext: string) => {
  const slug = lieu.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "photo";
  return `selfizee-${slug}-${date.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" })}.${ext}`;
};

/** Photo en pleine définition et GIF de la séance, dans la limite de taille (§ 6.1). La story n'est jamais jointe. */
async function piecesJointes(i: Pick<SouvenirInscription, "codeEvent" | "photoUuid">, lieu: string, date: Date): Promise<PieceJointe[]> {
  const medias = await prisma.media.findMany({
    where: { codeEvent: i.codeEvent, photoUuid: i.photoUuid, mediaStatut: "TELECHARGE", ...(avecTests() ? {} : { test: false }) },
    select: { mediaStatut: true, mediaChemin: true },
    orderBy: { id: "asc" },
  });
  const lisibles = medias.filter(affichable);
  const photo = lisibles.find((m) => extensionDuChemin(m.mediaChemin!) !== "gif");
  const anim = lisibles.find((m) => extensionDuChemin(m.mediaChemin!) === "gif");
  const pj: PieceJointe[] = [];
  if (photo) {
    const contenu = await lireBuffer(photo.mediaChemin!).catch(() => null);
    if (contenu && contenu.length <= PJ_MAX) pj.push({ nom: nomFichier(lieu, date, extensionDuChemin(photo.mediaChemin!)), type: mimeDe(photo.mediaChemin!), contenu });
  }
  if (anim) {
    let contenu = await lireBuffer(anim.mediaChemin!).catch(() => null);
    const place = PJ_MAX - pj.reduce((s, p) => s + p.contenu.length, 0);
    if (contenu && contenu.length > place) {
      contenu = await sharp(contenu, { animated: true }).resize({ width: 400, withoutEnlargement: true }).gif().toBuffer().catch(() => null);
    }
    if (contenu && contenu.length <= place) pj.push({ nom: "anim.gif", type: "image/gif", contenu });
  }
  return pj;
}

export async function preparerLivraison(i: SouvenirInscription): Promise<Preparation> {
  const j = { code: i.codeEvent, photoUuid: i.photoUuid };
  const base = basePublique();
  const s = await lireSeanceSouvenir(j, base ?? "", Date.now(), VALIDITE_MAIL_S);
  if (!s) return { refus: "Événement inconnu" };
  if (s.etat === "expiree") return { refus: "Séance expirée ou effacée" };
  if (s.etat === "en-attente") return { attente: true };
  const date = new Date(s.prisLe!);
  const pj = await piecesJointes(i, s.evenement.lieu, date);
  const photo = s.visuels.find((v) => v.type === "photo");
  const prix = s.evenement.tarifs.paliers.map((p) => p.unitPrice).filter((p) => p > 0);
  const l = s.evenement.liens;
  const mail = mailLivraison({
    lieu: s.evenement.lieu,
    ville: s.evenement.ville,
    date,
    page: lienPageSouvenir(i.codeEvent, i.photoUuid),
    ...(s.codeSeance ? { codeSeance: s.codeSeance } : {}),
    ...(prix.length ? { prixMin: Math.min(...prix) } : {}),
    ...(base && photo ? { apercu: `${photo.url}&l=500` } : {}),
    ...(l.avisGoogle ? { avis: lienSuivi("avis", i.id, l.avisGoogle) } : {}),
    instagram: lienSuivi("instagram", i.id, compteReseau("instagram", l.instagram)),
    tiktok: lienSuivi("tiktok", i.id, compteReseau("tiktok", l.tiktok)),
    hashtag: l.hashtag?.trim() || "@selfizee",
    avecGif: pj.some((p) => p.type === "image/gif"),
    pied: pied(raisonSeance(s.evenement.lieu, s.evenement.ville, date), i.id),
  });
  return { mail, pj };
}

async function envoyerLivraisons(maintenant: number, bilan: Bilan) {
  const livraisons = await prisma.souvenirLivraison.findMany({
    where: { etat: "A_ENVOYER", OR: [{ prochainEssai: null }, { prochainEssai: { lte: new Date(maintenant) } }] },
    include: { inscription: true },
    orderBy: { id: "asc" },
    take: PAR_PASSE,
  });
  for (const l of livraisons) {
    const i = l.inscription;
    if (!i.email) {
      await prisma.souvenirLivraison.update({ where: { id: l.id }, data: { etat: "ECHEC", erreur: "Inscription effacée" } });
      continue;
    }
    const p = await preparerLivraison(i).catch((e: Error) => ({ refus: `Préparation : ${e.message}` }));
    if ("attente" in p) {
      await prisma.souvenirLivraison.update({ where: { id: l.id }, data: { etat: "EN_ATTENTE_MEDIA" } });
      continue;
    }
    if ("refus" in p) {
      await prisma.souvenirLivraison.update({ where: { id: l.id }, data: { etat: "ECHEC", erreur: p.refus } });
      bilan.echecs++;
      continue;
    }
    const erreur = await envoyerEmail(i.email, p.mail.sujet, p.mail.html, p.pj, { expediteur: expediteur(), texte: p.mail.texte, idSuivi: idSuivi("l", l.id) }).catch(
      (e: Error) => e.message
    );
    await prisma.souvenirLivraison.update({ where: { id: l.id }, data: apresEssai(erreur, l.tentatives, maintenant, bilan) });
  }
}

/** Suite d'un essai : envoyé, à réessayer plus tard, ou en échec après ESSAIS_MAX refus. */
function apresEssai(erreur: string | null, tentatives: number, maintenant: number, bilan: Bilan) {
  if (!erreur) {
    bilan.envoyes++;
    return { etat: "ENVOYE" as const, envoyeLe: new Date(maintenant), erreur: null, prochainEssai: null };
  }
  const t = tentatives + 1;
  if (t >= ESSAIS_MAX) {
    bilan.echecs++;
    return { etat: "ECHEC" as const, erreur: erreur.slice(0, 500), tentatives: t, prochainEssai: null };
  }
  return { erreur: erreur.slice(0, 500), tentatives: t, prochainEssai: new Date(maintenant + delaiEssai(t)) };
}

// ─── Mail 2 : code gagné ───

async function envoyerCodes(maintenant: number, bilan: Bilan) {
  const cartes = await prisma.souvenirCarte.findMany({
    where: {
      lot: { not: "none" },
      reveleeLe: { not: null },
      mailEnvoyeLe: null,
      mailTentatives: { lt: ESSAIS_MAX },
      OR: [{ mailProchainEssai: null }, { mailProchainEssai: { lte: new Date(maintenant) } }],
      inscription: { email: { not: null } },
    },
    include: { inscription: true, codeRemise: { select: { code: true } } },
    take: PAR_PASSE,
  });
  for (const c of cartes) {
    const i = c.inscription;
    if (!c.codeRemise || !i.email) {
      await prisma.souvenirCarte.update({ where: { id: c.id }, data: { mailTentatives: ESSAIS_MAX, mailErreur: "Code ou adresse effacés" } });
      continue;
    }
    const s = await lireSeanceSouvenir({ code: i.codeEvent, photoUuid: i.photoUuid }, basePublique() ?? "", maintenant, VALIDITE_MAIL_S).catch(() => null);
    const page = adressePage();
    const illustrations = basePublique() && s?.evenement.illustrations.length ? s.evenement.illustrations : ILLUSTRATIONS_PAGE.map((p) => `${page}${p}`);
    const date = s?.prisLe ? new Date(s.prisLe) : i.createdAt;
    const mail = mailCode({
      lot: c.lot as LotGagne,
      code: c.codeRemise.code,
      illustrations,
      pied: pied(raisonSeance(s?.evenement.lieu ?? "", s?.evenement.ville ?? "", date), i.id),
    });
    const erreur = await envoyerEmail(i.email, mail.sujet, mail.html, [], { expediteur: expediteur(), texte: mail.texte, idSuivi: idSuivi("c", c.id) }).catch(
      (e: Error) => e.message
    );
    const t = c.mailTentatives + 1;
    if (!erreur) bilan.envoyes++;
    else if (t >= ESSAIS_MAX) bilan.echecs++;
    await prisma.souvenirCarte.update({
      where: { id: c.id },
      data: erreur
        ? { mailErreur: erreur.slice(0, 500), mailTentatives: t, mailProchainEssai: new Date(maintenant + delaiEssai(t)) }
        : { mailEnvoyeLe: new Date(maintenant), mailErreur: null },
    });
  }
}

// ─── Photo introuvable 24 h après l'inscription (§ 4.1) ───

async function signalerIntrouvables(maintenant: number, bilan: Bilan) {
  const vieilles = await prisma.souvenirLivraison.findMany({
    where: { etat: "EN_ATTENTE_MEDIA", createdAt: { lt: new Date(maintenant - JOUR) } },
    include: { inscription: true },
    orderBy: { id: "asc" },
    take: PAR_PASSE,
  });
  const parInscription = new Map<string, SouvenirInscription>();
  for (const l of vieilles) parInscription.set(l.inscriptionId, l.inscription);
  for (const i of parInscription.values()) {
    const j = { code: i.codeEvent, photoUuid: i.photoUuid };
    const ctx = await contexteSeance(j, maintenant);
    if (ctx?.etat === "disponible") {
      // Arrivée entre-temps : la livraison part à la passe suivante
      await prisma.souvenirLivraison.updateMany({ where: { inscriptionId: i.id, etat: "EN_ATTENTE_MEDIA" }, data: { etat: "A_ENVOYER" } });
      continue;
    }
    let erreur: string | null = "Inscription effacée";
    if (i.email) {
      const ev = await evenementAffiche(i.codeEvent).catch(() => null);
      const lieu = ev?.r.lieu.nom || ev?.e.lieu.enseigne || "";
      const ville = ev?.r.lieu.ville ?? ev?.e.lieu.ville ?? "";
      const mail = mailIntrouvable({ lieu, ville, date: i.createdAt, page: lienPageSouvenir(i.codeEvent, i.photoUuid), pied: pied(raisonSeance(lieu, ville, i.createdAt), i.id) });
      erreur = await envoyerEmail(i.email, mail.sujet, mail.html, [], { expediteur: expediteur(), texte: mail.texte }).catch((e: Error) => e.message);
      if (erreur) bilan.echecs++;
      else bilan.envoyes++;
    }
    // La photo peut encore arriver : rattraperLivraisons la remet alors « à envoyer »
    await prisma.souvenirLivraison.updateMany({
      where: { inscriptionId: i.id, etat: "EN_ATTENTE_MEDIA" },
      data: { etat: "PHOTO_INTROUVABLE", erreur: erreur?.slice(0, 500) ?? null },
    });
  }
}

// ─── Passes ───

let enCours: Promise<Bilan> | null = null;
let relancer = false;

/**
 * Envoie ce qui attend (mails 1 et 2, photos introuvables). Une seule passe à la fois : un appel pendant une passe
 * la fait recommencer une fois finie, et renvoie la même promesse.
 */
export function envoyerEnAttente(maintenant?: number): Promise<Bilan> {
  if (enCours) {
    relancer = true;
    return enCours;
  }
  enCours = (async () => {
    const bilan: Bilan = { envoyes: 0, echecs: 0 };
    if (!emailConfigure()) return bilan;
    do {
      relancer = false;
      const t = maintenant ?? Date.now();
      await envoyerLivraisons(t, bilan);
      await envoyerCodes(t, bilan);
      await signalerIntrouvables(t, bilan);
    } while (relancer);
    return bilan;
  })().finally(() => {
    enCours = null;
  });
  return enCours;
}

/** Après une action de l'invité : passe d'envoi sans attendre (le planificateur rattrape les erreurs). */
export function declencherEnvois() {
  envoyerEnAttente().catch((err) => console.error("Mails de la page souvenir :", err));
}

// ─── Mail 3 : lien « Toutes tes photos » ───

/** Envoie le lien à l'adresse (qui a au moins une livraison : demanderLien l'a vérifié). */
export async function envoyerLienParMail(email: string, jeton: string, maintenant = Date.now()): Promise<string | null> {
  if (!emailConfigure()) {
    console.log("[mail 3 non envoyé — MAILJET_API_KEY / MAILJET_API_SECRET absents]");
    return "Envoi désactivé";
  }
  const ins = await prisma.souvenirInscription.findMany({
    where: { email, createdAt: { gt: new Date(maintenant - CONSERVATION_JOURS * JOUR) }, livraisons: { some: { etat: { in: ["A_ENVOYER", "ENVOYE"] } } } },
    select: { codeEvent: true, photoUuid: true, lieu: { select: { enseigne: true } } },
  });
  const seances = new Set(ins.map((i) => `${i.codeEvent}:${i.photoUuid}`));
  const lieux = [...new Set(ins.map((i) => i.lieu?.enseigne).filter((l): l is string => Boolean(l)))].slice(0, 4);
  const mail = mailToutes({
    nombre: seances.size,
    lieux,
    lien: `${adressePage()}/mine/${jeton}`,
    pied: pied("Tu reçois ce mail parce que tu as demandé le lien de tes photos Selfizee."),
  });
  return envoyerEmail(email, mail.sujet, mail.html, [], { expediteur: expediteur(), texte: mail.texte });
}

// ─── Rebonds (webhook Mailjet) ───

export interface EvenementMailjet {
  event?: string;
  hard_bounce?: boolean;
  error_related_to?: string;
  error?: string;
  CustomID?: string;
}

/**
 * Rebond dur ou adresse bloquée par Mailjet (CDC § 6, § 11) : la livraison passe en « échec », et l'écran
 * « C'est envoyé » de l'invité affiche « Cette adresse ne reçoit pas nos mails. Vérifie-la. ».
 */
export async function traiterEvenementsMailjet(evenements: EvenementMailjet[]): Promise<number> {
  let n = 0;
  for (const e of evenements) {
    const dur = (e.event === "bounce" && e.hard_bounce === true) || e.event === "blocked";
    const m = /^souvenir-([lc])-(\d{1,18})$/.exec(String(e.CustomID ?? ""));
    if (!dur || !m) continue;
    const motif = `${REBOND} : ${[e.error_related_to, e.error].filter(Boolean).join(", ") || e.event}`.slice(0, 300);
    const r =
      m[1] === "l"
        ? await prisma.souvenirLivraison.updateMany({ where: { id: BigInt(m[2]) }, data: { etat: "ECHEC", erreur: motif } })
        : await prisma.souvenirCarte.updateMany({ where: { id: Number(m[2]) }, data: { mailErreur: motif } });
    n += r.count;
  }
  return n;
}
