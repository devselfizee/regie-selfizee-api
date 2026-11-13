import { createHash, randomBytes, randomInt } from "node:crypto";
import { Prisma, type SouvenirInscription, type SouvenirLivraison } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { TZDate } from "@date-fns/tz";
import { FUSEAU_METIER, jourEtHeureLocaux } from "../lib/temps.js";
import { genererCode } from "../codes/codes.js";
import { purgerMedia } from "../synchro-pikcloud/telechargement.js";
import { LOTS } from "../config-evenement/reglages.js";
import { ecrireJeton, type JetonSouvenir } from "./jeton.js";
import { CONSERVATION_JOURS, contexteSeance } from "./seance.js";

// Ce que l'invité fait sur la page souvenir, stocké dans la Régie (CDC page souvenir § 1.2, § 4.2 à 4.8, § 7, § 9).
// Toutes les règles sont tenues ici, côté serveur : limites, tirage du lot, codes uniques, conservation.

const MINUTE = 60_000;
const HEURE = 60 * MINUTE;
const JOUR = 24 * HEURE;
/** Codes gagnés : valables 30 jours sur toutes les bornes en régie (CDC § 7). */
const VALIDITE_CODE_JOURS = 30;
const LIBELLE_LOT = "Carte à gratter (page souvenir)";

export type Lot = (typeof LOTS)[number];
export class RefusSouvenir extends Error {}
/** Début du motif d'une livraison refusée par la boîte du destinataire (webhook Mailjet) */
export const REBOND = "Rebond";
/** Livraison qui attend la photo : pas encore arrivée, ou signalée introuvable après 24 h (elle peut encore arriver) */
const ATTENTE_PHOTO = ["EN_ATTENTE_MEDIA", "PHOTO_INTROUVABLE"] as const;

// ─── Inscriptions et livraisons ───

export interface DonneesInscription {
  email: string;
  prenom?: string;
  estMoi: boolean;
  optinLieu: boolean;
  optinSelfizee: boolean;
  textes: string[];
  ip: string;
  userAgent: string;
}

type InscriptionChargee = SouvenirInscription & {
  livraisons: SouvenirLivraison[];
  carte: { lot: string; reveleeLe: Date | null; codeRemise: { code: string } | null } | null;
};
const inclure = { livraisons: { orderBy: { id: "asc" } }, carte: { select: { lot: true, reveleeLe: true, codeRemise: { select: { code: true } } } } } as const;

/** Ce que la page souvenir reçoit d'une inscription (jamais l'IP ni le navigateur). */
function versPage(i: InscriptionChargee) {
  return {
    id: i.id,
    token: ecrireJeton(i.codeEvent, i.photoUuid),
    email: i.email ?? "",
    ...(i.prenom ? { prenom: i.prenom } : {}),
    optinLieu: i.optinLieu,
    optinSelfizee: i.optinSelfizee,
    creeLe: i.createdAt.toISOString(),
    // Envois du mail 1 déclenchés (la livraison en attente de la photo n'en est pas un)
    envois: i.livraisons.filter((l) => !(ATTENTE_PHOTO as readonly string[]).includes(l.etat)).map((l) => l.createdAt.getTime()),
    // Adresse refusée par sa boîte (rebond dur) : « Cette adresse ne reçoit pas nos mails » (CDC § 11)
    echec: i.livraisons.some((l) => l.etat === "ECHEC" && Boolean(l.erreur?.startsWith(REBOND))),
    ...(i.carte ? { carte: { lot: i.carte.lot, revelee: Boolean(i.carte.reveleeLe), ...(i.carte.codeRemise ? { code: i.carte.codeRemise.code } : {}) } } : {}),
  };
}
export type InscriptionPage = ReturnType<typeof versPage>;

const deLaSeance = (j: JetonSouvenir) => ({ codeEvent: j.code, photoUuid: j.photoUuid });

/**
 * Inscription « Recevoir mes photos » (CDC § 4.2) : plusieurs par séance ; la même adresse sur la même séance
 * renvoie le mail au lieu d'une erreur. 5 par séance, par heure et par IP ; 50 par séance au total.
 */
export async function inscrire(j: JetonSouvenir, d: DonneesInscription, maintenant = Date.now()): Promise<InscriptionPage> {
  const ctx = await contexteSeance(j, maintenant);
  if (!ctx || ctx.etat === "expiree") throw new RefusSouvenir("Cette page a expiré.");
  if (!d.estMoi) throw new RefusSouvenir("Coche la case « C'est bien moi ».");
  const etat = ctx.etat === "disponible" ? "A_ENVOYER" : "EN_ATTENTE_MEDIA";

  const deja = await prisma.souvenirInscription.findFirst({ where: { ...deLaSeance(j), email: d.email }, include: inclure });
  if (deja) {
    // Même adresse : renvoi du mail (dans la limite des renvois), pas de nouvelle inscription
    if (deja.livraisons.filter((l) => l.renvoi && l.createdAt.getTime() > maintenant - HEURE).length < 3) {
      await prisma.souvenirLivraison.create({ data: { inscriptionId: deja.id, renvoi: true, etat } });
    }
    await journaliser("mail_resent", j, ctx.evenement.lieuId);
    return versPage(await prisma.souvenirInscription.findUniqueOrThrow({ where: { id: deja.id }, include: inclure }));
  }

  const [total, recentes] = await Promise.all([
    prisma.souvenirInscription.count({ where: deLaSeance(j) }),
    prisma.souvenirInscription.count({ where: { ...deLaSeance(j), ipTronquee: d.ip, createdAt: { gt: new Date(maintenant - HEURE) } } }),
  ]);
  if (total >= 50 || recentes >= 5) throw new RefusSouvenir("Trop de demandes pour cette photo. Écris-nous à contact@selfizee.fr.");

  const i = await prisma.souvenirInscription.create({
    data: {
      ...deLaSeance(j),
      configEvenementId: ctx.evenement.id,
      lieuId: ctx.evenement.lieuId,
      email: d.email,
      prenom: d.prenom || null,
      estMoi: true,
      optinLieu: d.optinLieu,
      optinSelfizee: d.optinSelfizee,
      textes: d.textes,
      ipTronquee: d.ip,
      userAgent: d.userAgent.slice(0, 400),
      livraisons: { create: { etat } },
    },
    include: inclure,
  });
  await journaliser("registered", j, ctx.evenement.lieuId, { optinLieu: d.optinLieu, optinSelfizee: d.optinSelfizee });
  if (etat === "A_ENVOYER") await journaliser("mail_sent", j, ctx.evenement.lieuId);
  return versPage(i);
}

/** L'inscription de cette séance ; si la photo est arrivée depuis, sa livraison en attente part (CDC § 6.1). */
export async function inscription(j: JetonSouvenir, id: string, maintenant = Date.now()): Promise<InscriptionPage | null> {
  const i = await prisma.souvenirInscription.findFirst({ where: { id, ...deLaSeance(j), email: { not: null } }, include: inclure });
  if (!i) return null;
  if (i.livraisons.some((l) => (ATTENTE_PHOTO as readonly string[]).includes(l.etat)) && (await contexteSeance(j, maintenant))?.etat === "disponible") {
    await debloquerLivraisons([i.id]);
    await journaliser("mail_sent", j, i.lieuId, { differe: true });
    return versPage(await prisma.souvenirInscription.findUniqueOrThrow({ where: { id }, include: inclure }));
  }
  return versPage(i);
}

const debloquerLivraisons = (inscriptions: string[]) =>
  prisma.souvenirLivraison.updateMany({ where: { inscriptionId: { in: inscriptions }, etat: { in: [...ATTENTE_PHOTO] } }, data: { etat: "A_ENVOYER" } });

/** « Renvoyer » (CDC § 4.3) : 3 renvois par heure au plus. */
export async function renvoyer(j: JetonSouvenir, id: string, maintenant = Date.now()): Promise<void> {
  const i = await prisma.souvenirInscription.findFirst({ where: { id, ...deLaSeance(j), email: { not: null } }, include: { livraisons: true } });
  if (!i) throw new RefusSouvenir("Inscription introuvable.");
  if (i.livraisons.filter((l) => l.renvoi && l.createdAt.getTime() > maintenant - HEURE).length >= 3) {
    throw new RefusSouvenir("Déjà renvoyé trois fois cette heure-ci. Regarde dans tes spams.");
  }
  const ctx = await contexteSeance(j, maintenant);
  await prisma.souvenirLivraison.create({ data: { inscriptionId: id, renvoi: true, etat: ctx?.etat === "disponible" ? "A_ENVOYER" : "EN_ATTENTE_MEDIA" } });
  await journaliser("mail_resent", j, i.lieuId);
}

/** Livraisons en attente dont la photo est arrivée depuis : passées « à envoyer » (rattrapage du planificateur). */
export async function rattraperLivraisons(maintenant = Date.now()): Promise<number> {
  const enAttente = await prisma.souvenirLivraison.findMany({
    where: { etat: { in: [...ATTENTE_PHOTO] }, createdAt: { gt: new Date(maintenant - CONSERVATION_JOURS * JOUR) } },
    select: { inscription: { select: { id: true, codeEvent: true, photoUuid: true } } },
    take: 500,
  });
  const parSeance = new Map<string, { j: JetonSouvenir; ids: string[] }>();
  for (const { inscription: i } of enAttente) {
    const cle = `${i.codeEvent}:${i.photoUuid}`;
    const s = parSeance.get(cle) ?? { j: { code: i.codeEvent, photoUuid: i.photoUuid }, ids: [] };
    s.ids.push(i.id);
    parSeance.set(cle, s);
  }
  let n = 0;
  for (const { j, ids } of parSeance.values()) {
    if ((await contexteSeance(j, maintenant))?.etat === "disponible") n += (await debloquerLivraisons(ids)).count;
  }
  return n;
}

// ─── Carte à gratter (CDC § 4.3 bis et § 7) ───

/** Lot tiré selon les poids réglés sur l'événement ; « rien » au-delà du plafond de lots gagnés du jour. */
export function tirerLot(lots: Record<Lot, number>, plafondAtteint: boolean, tirer: (n: number) => number = randomInt): Lot {
  if (plafondAtteint) return "none";
  const somme = LOTS.reduce((s, l) => s + Math.max(0, lots[l]), 0);
  if (somme <= 0) return "none";
  let r = tirer(somme);
  return LOTS.find((l) => (r -= Math.max(0, lots[l])) < 0) ?? "none";
}

/**
 * Le code de remise d'un lot gagné : un vrai code de la Régie (vérifié par la borne comme les autres), à usage unique,
 * valable 30 jours sur toutes les bornes en régie. Les codes d'un même jour, lieu et lot sont rangés dans un même lot
 * de codes (page Codes de remise).
 */
async function creerCodeGagne(db: Prisma.TransactionClient, lot: Exclude<Lot, "none">, lieuId: number | null, maintenant: Date): Promise<number> {
  const { jour } = jourEtHeureLocaux(maintenant);
  const expireLe = new Date(jour.getTime() + VALIDITE_CODE_JOURS * JOUR);
  const valeur = lot === "free" ? { type: "OFFERT" as const, pourcentage: null } : { type: "POURCENTAGE" as const, pourcentage: lot === "pct50" ? 50 : 30 };
  const cle = { libelle: LIBELLE_LOT, lieuId, seulementLieu: false, quantite: 1, expireLe, ...valeur };
  const existant = await db.lotCodesRemise.findFirst({ where: cle, select: { id: true } });
  const lotId = existant
    ? (await db.lotCodesRemise.update({ where: { id: existant.id }, data: { nbCodes: { increment: 1 } } })).id
    : (await db.lotCodesRemise.create({ data: { ...cle, nbCodes: 1 } })).id;
  for (let essai = 0; essai < 20; essai++) {
    const code = genererCode();
    const deja = await db.codeRemise.findUnique({ where: { code }, select: { id: true } });
    if (!deja) return (await db.codeRemise.create({ data: { code, lotId } })).id;
  }
  throw new Error("Impossible de tirer un code de remise libre");
}

/** Tire la carte de l'inscription à l'affichage de l'écran (idempotent : une carte par inscription). */
export async function gratter(j: JetonSouvenir, id: string, maintenant = Date.now()): Promise<NonNullable<InscriptionPage["carte"]>> {
  const i = await prisma.souvenirInscription.findFirst({ where: { id, ...deLaSeance(j), email: { not: null } }, include: inclure });
  if (!i) throw new RefusSouvenir("Inscription introuvable.");
  if (i.carte) return versPage(i).carte!;
  const ctx = await contexteSeance(j, maintenant);
  const jeu = ctx?.reglages.tarifs.jeu;
  try {
    await prisma.$transaction(async (db) => {
      let lot: Lot = "none";
      if (jeu?.actif && ctx) {
        // Plafond de lots gagnés par jour (heure de Paris) sur l'événement
        const { jour } = jourEtHeureLocaux(new Date(maintenant));
        const debutJour = new Date(new TZDate(jour.getUTCFullYear(), jour.getUTCMonth(), jour.getUTCDate(), 0, 0, 0, FUSEAU_METIER).getTime());
        const gagnes = await db.souvenirCarte.count({
          where: { lot: { not: "none" }, createdAt: { gte: debutJour }, inscription: { configEvenementId: ctx.evenement.id } },
        });
        lot = tirerLot(jeu.lots, gagnes >= jeu.maxLotsParJour);
      }
      const codeRemiseId = lot === "none" ? null : await creerCodeGagne(db, lot, i.lieuId, new Date(maintenant));
      await db.souvenirCarte.create({ data: { inscriptionId: i.id, lot, codeRemiseId } });
    });
  } catch (e) {
    // Deux affichages simultanés : la première carte gagne, la seconde transaction est annulée
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  const apres = await prisma.souvenirInscription.findUniqueOrThrow({ where: { id: i.id }, include: inclure });
  await journaliser("scratch_shown", j, i.lieuId, { lot: apres.carte!.lot });
  return versPage(apres).carte!;
}

export async function reveler(j: JetonSouvenir, id: string): Promise<void> {
  const c = await prisma.souvenirCarte.findFirst({ where: { inscriptionId: id, reveleeLe: null, inscription: deLaSeance(j) }, select: { id: true, lot: true, inscription: { select: { lieuId: true } } } });
  if (!c) return;
  await prisma.souvenirCarte.update({ where: { id: c.id }, data: { reveleeLe: new Date() } });
  await journaliser("scratch_revealed", j, c.inscription.lieuId, { lot: c.lot });
}

// ─── Lien magique « Toutes tes photos » (CDC § 4.6, § 4.7) ───

const empreinte = (jeton: string) => createHash("sha256").update(jeton).digest("hex");

/** Adresse ayant au moins une livraison sur 90 jours : crée un lien de 24 h. Rien sinon (même réponse au visiteur). */
export async function demanderLien(email: string, maintenant = Date.now()): Promise<string | null> {
  const livree = await prisma.souvenirInscription.findFirst({
    where: { email, createdAt: { gt: new Date(maintenant - CONSERVATION_JOURS * JOUR) }, livraisons: { some: { etat: { in: ["A_ENVOYER", "ENVOYE"] } } } },
    select: { id: true },
  });
  await journaliser("mine_requested", null, null);
  if (!livree) return null;
  const jeton = randomBytes(24).toString("base64url");
  await prisma.souvenirLien.create({ data: { jetonHash: empreinte(jeton), email, expireLe: new Date(maintenant + JOUR) } });
  return jeton;
}

/**
 * Les séances livrées à l'adresse du lien, sur 90 jours. Lien valable 24 h et à usage unique : la première ouverture
 * le consomme, avec une heure de grâce pour naviguer entre les photos.
 */
export async function mesSeances(jeton: string, maintenant = Date.now()): Promise<{ email: string; tokens: string[] } | null> {
  const l = await prisma.souvenirLien.findUnique({ where: { jetonHash: empreinte(jeton) } });
  if (!l || l.expireLe.getTime() < maintenant) return null;
  if (l.ouvertLe && l.ouvertLe.getTime() < maintenant - HEURE) return null;
  if (!l.ouvertLe) {
    await prisma.souvenirLien.update({ where: { id: l.id }, data: { ouvertLe: new Date(maintenant) } });
    await journaliser("mine_opened", null, null);
  }
  const ins = await prisma.souvenirInscription.findMany({
    where: { email: l.email, createdAt: { gt: new Date(maintenant - CONSERVATION_JOURS * JOUR) }, livraisons: { some: { etat: { in: ["A_ENVOYER", "ENVOYE"] } } } },
    select: { codeEvent: true, photoUuid: true },
    orderBy: { createdAt: "desc" },
  });
  return { email: l.email, tokens: [...new Set(ins.map((i) => ecrireJeton(i.codeEvent, i.photoUuid)))] };
}

// ─── Journal (CDC § 4.8) : compteurs sans donnée personnelle ───

export const EVENEMENTS_JOURNAL = [
  "page_view", "carousel_swipe", "form_open", "registered", "mail_sent", "mail_resent", "scratch_shown", "scratch_revealed",
  "reprint_open", "reprint_paid", "mine_requested", "mine_opened",
] as const;
/** Événements venus des mails et des droits de l'invité (jamais postés par la page) */
export type EvenementJournal = (typeof EVENEMENTS_JOURNAL)[number] | "review_click" | "social_click" | "data_deleted" | "data_updated";
/** Seuls détails gardés : jamais d'e-mail, de code ni d'IP. */
const DETAILS_PERMIS = new Set(["lot", "optinLieu", "optinSelfizee", "differe", "copies", "montant", "index", "reseau", "photos"]);

export async function journaliser(evenement: EvenementJournal, j: JetonSouvenir | null, lieuId: number | null | undefined, details?: Record<string, unknown>) {
  const propres = details ? Object.fromEntries(Object.entries(details).filter(([k, v]) => DETAILS_PERMIS.has(k) && ["string", "number", "boolean"].includes(typeof v))) : null;
  await prisma.souvenirJournal.create({
    data: {
      evenement,
      codeEvent: j?.code ?? null,
      photoUuid: j?.photoUuid ?? null,
      lieuId: lieuId ?? null,
      details: propres && Object.keys(propres).length ? (propres as Prisma.InputJsonObject) : Prisma.DbNull,
    },
  });
}

/** Journal venu de la page (scan, geste dans le carrousel…) : l'événement et le lieu sont retrouvés par le jeton. */
export async function journaliserDepuisPage(evenement: EvenementJournal, j: JetonSouvenir | null, details?: Record<string, unknown>) {
  const lieuId = j ? (await prisma.configEvenement.findUnique({ where: { code: j.code }, select: { lieuId: true } }))?.lieuId : null;
  if (j && lieuId === undefined) return; // événement inconnu : rien à compter
  await journaliser(evenement, j, lieuId, details);
}

// ─── « Supprimer mes photos » (CDC § 9.3) ───

/** Ce que la page de confirmation montre : lieu, date, et si d'autres personnes ont demandé la même photo. */
export async function infoOubli(id: string) {
  const i = await prisma.souvenirInscription.findFirst({
    where: { id, email: { not: null } },
    select: { id: true, codeEvent: true, photoUuid: true, createdAt: true, lieu: { select: { enseigne: true } } },
  });
  if (!i) return null;
  const autres = await prisma.souvenirInscription.count({ where: { ...deLaSeance({ code: i.codeEvent, photoUuid: i.photoUuid }), email: { not: null }, id: { not: id } } });
  return { lieu: i.lieu?.enseigne ?? "", date: i.createdAt.toISOString(), seule: autres === 0 };
}

/**
 * Efface l'e-mail, le prénom et les traces techniques de l'inscription, et annule ses envois en attente. Si personne
 * d'autre n'a demandé cette photo, ses fichiers sont effacés aussi (la page de la séance expire). Les ventes, les
 * cartes et les compteurs restent, sans donnée personnelle. null : déjà effacée ou inconnue.
 */
export async function oublier(id: string, maintenant = Date.now()): Promise<{ photosEffacees: boolean } | null> {
  const i = await prisma.souvenirInscription.findFirst({ where: { id, email: { not: null } }, select: { id: true, codeEvent: true, photoUuid: true, lieuId: true } });
  if (!i) return null;
  const j = { code: i.codeEvent, photoUuid: i.photoUuid };
  await prisma.souvenirInscription.update({
    where: { id: i.id },
    data: { email: null, prenom: null, ipTronquee: null, userAgent: null, anonymiseeLe: new Date(maintenant) },
  });
  await prisma.souvenirLivraison.deleteMany({ where: { inscriptionId: i.id, etat: { in: ["A_ENVOYER", ...ATTENTE_PHOTO] } } });
  const autres = await prisma.souvenirInscription.count({ where: { ...deLaSeance(j), email: { not: null } } });
  let photosEffacees = false;
  if (autres === 0) {
    const medias = await prisma.media.findMany({
      where: { codeEvent: i.codeEvent, photoUuid: i.photoUuid, mediaStatut: "TELECHARGE" },
      select: { id: true, mediaChemin: true, vignetteChemin: true },
    });
    for (const m of medias) await purgerMedia(m, "RGPD");
    photosEffacees = true;
  }
  await journaliser("data_deleted", j, i.lieuId, { photos: photosEffacees });
  return { photosEffacees };
}

// ─── Conservation (CDC § 9.2) ───

/**
 * Au-delà de 90 jours : e-mail, prénom, IP et navigateur effacés des inscriptions sans opt-in ; IP et navigateur
 * effacés des autres (le contact opt-in reste tant que l'opt-in vaut). Liens magiques expirés supprimés.
 * Les compteurs (lignes, cartes, journal) restent.
 */
export async function purgerSouvenir(maintenant = Date.now()) {
  const limite = new Date(maintenant - CONSERVATION_JOURS * JOUR);
  const [sansOptin, avecOptin, liens] = await Promise.all([
    prisma.souvenirInscription.updateMany({
      where: { createdAt: { lt: limite }, anonymiseeLe: null, optinLieu: false, optinSelfizee: false },
      data: { email: null, prenom: null, ipTronquee: null, userAgent: null, anonymiseeLe: new Date(maintenant) },
    }),
    prisma.souvenirInscription.updateMany({
      where: { createdAt: { lt: limite }, OR: [{ ipTronquee: { not: null } }, { userAgent: { not: null } }] },
      data: { ipTronquee: null, userAgent: null },
    }),
    prisma.souvenirLien.deleteMany({ where: { expireLe: { lt: new Date(maintenant - JOUR) } } }),
  ]);
  return { anonymisees: sansOptin.count, nettoyees: avecOptin.count, liens: liens.count };
}
