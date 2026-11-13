import { TZDate } from "@date-fns/tz";
import type { Borne, Declencheur, EtatInstallation, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { FUSEAU_METIER } from "../lib/temps.js";
import { reglagesSchema } from "./reglages.js";
import { etatDuZip, lieuDeLaBorne, selectionZip } from "./zipBorne.js";

// Mise à jour automatique des événements sur la borne (13/11/2026). La borne interroge la Régie avec sa clé :
// - programme : l'événement qui doit tourner chez elle maintenant, d'après la programmation de son lieu (le par défaut,
//   ou l'événement personnalisé en cours), et les prochains changements, chacun avec sa version publiée ;
// - versions : la version publiée de plusieurs codes à la fois (comme getEventLastUpdate du booth) ;
// - installation : ce qu'elle a téléchargé ou installé, pour que la Régie sache quelle version tourne où.
// Le zip lui-même se demande ensuite par /statut (URL signée) puis se télécharge (zipBorne.ts).

/** Combien de jours de programmation à venir la borne reçoit (de quoi précharger les zips). */
const HORIZON_JOURS = 14;
const MAX_PROCHAINS = 10;

export type EtatZip = "complete" | "incomplete" | "obsolete";

export interface EvenementBorne {
  code: string;
  /** null pour l'événement par défaut */
  nom: string | null;
  parDefaut: boolean;
  /** Version publiée (0 : jamais publié) et date de publication */
  version: number;
  publieLe: string | null;
  status: EtatZip;
}

export interface ProgrammeBorne {
  /** Lieu où la borne est installée ; null : borne non affectée (aucun événement) */
  lieu: { id: number; nom: string } | null;
  maintenant: string;
  /** L'événement à faire tourner maintenant ; null si rien n'est prêt (aucun événement publié) */
  actuel: (EvenementBorne & { jusqua: string | null }) | null;
  /** Prochains événements personnalisés (14 jours, 10 au plus), du plus proche au plus lointain */
  prochains: (EvenementBorne & { debut: string; fin: string })[];
}

/** « 2026-11-13 » + « 20:00 » (heure de Paris ; null = début ou fin de journée) → instant. */
function instantParis(jour: string, heure: string | null, fin: boolean): Date {
  const [a, m, j] = jour.split("-").map(Number);
  if (heure === null) return new Date(new TZDate(a, m - 1, j + (fin ? 1 : 0), 0, 0, 0, FUSEAU_METIER).getTime());
  const [h, mi] = heure.split(":").map(Number);
  return new Date(new TZDate(a, m - 1, j, h, mi, 0, FUSEAU_METIER).getTime());
}

/** Date ISO avec le décalage de Paris (« 2026-11-13T20:00:00.000+01:00 ») : lisible tel quel sur la borne. */
const isoParis = (d: Date) => new TZDate(d.getTime(), FUSEAU_METIER).toISOString();

type Ligne = Awaited<ReturnType<typeof chargerEvenements>>[number];
const chargerEvenements = (lieuId: number) =>
  prisma.configEvenement.findMany({ where: { lieuId }, select: { ...selectionZip, id: true, nom: true, habituel: true, reglages: true } });

async function versBorne(e: Ligne): Promise<EvenementBorne> {
  return {
    code: e.code,
    nom: e.habituel ? null : e.nom,
    parDefaut: e.habituel,
    version: e.version,
    publieLe: e.publieeLe ? e.publieeLe.toISOString() : null,
    status: await etatDuZip(e),
  };
}

/**
 * Programme de la borne. L'événement actuel suit la règle de l'onglet Configuration : parmi les événements
 * personnalisés en cours, celui qui a commencé le plus tard ; sinon le par défaut. Un événement dont le zip n'est pas
 * prêt (jamais publié, ou à republier) est sauté : la borne garde ce qui marche (le par défaut).
 */
export async function programmePourBorne(borne: Pick<Borne, "id">, maintenant = new Date()): Promise<ProgrammeBorne> {
  const lieuId = await lieuDeLaBorne(borne.id, maintenant);
  if (lieuId === null) return { lieu: null, maintenant: isoParis(maintenant), actuel: null, prochains: [] };
  const [lieu, evenements] = await Promise.all([prisma.lieu.findUnique({ where: { id: lieuId }, select: { id: true, enseigne: true } }), chargerEvenements(lieuId)]);

  const t = maintenant.getTime();
  const horizon = t + HORIZON_JOURS * 86_400_000;
  // Un événement aux réglages illisibles (ancien format) est ignoré : il ne doit pas priver le lieu de son programme
  const lisibles = evenements.flatMap((e) => {
    if (e.habituel) return [];
    const r = reglagesSchema.safeParse(e.reglages);
    if (!r.success) console.error(`Programme des bornes : réglages illisibles pour l'événement ${e.code}, ignoré`);
    return r.success ? [{ e, l: r.data.lieu }] : [];
  });
  const ponctuels = await Promise.all(
    lisibles.map(async ({ e, l }) => ({ e, b: await versBorne(e), debut: instantParis(l.dateDebut, l.heureDebut, false), fin: instantParis(l.dateFin, l.heureFin, true) }))
  );
  const defaut = evenements.find((e) => e.habituel);
  const bDefaut = defaut ? await versBorne(defaut) : null;

  // En cours et prêts : celui qui a commencé le plus tard
  const enCours = ponctuels
    .filter((p) => p.debut.getTime() <= t && t < p.fin.getTime() && p.b.status === "complete")
    .sort((x, y) => y.debut.getTime() - x.debut.getTime())[0];
  let actuel: ProgrammeBorne["actuel"] = null;
  if (enCours) actuel = { ...enCours.b, jusqua: enCours.fin.toISOString() };
  else if (bDefaut?.status === "complete") {
    // Le par défaut tourne jusqu'au prochain événement prêt
    const suivant = ponctuels.filter((p) => p.debut.getTime() > t && p.b.status === "complete").sort((x, y) => x.debut.getTime() - y.debut.getTime())[0];
    actuel = { ...bDefaut, jusqua: suivant ? suivant.debut.toISOString() : null };
  }
  if (actuel?.jusqua) actuel.jusqua = isoParis(new Date(actuel.jusqua));

  const prochains = ponctuels
    .filter((p) => p.debut.getTime() > t && p.debut.getTime() <= horizon)
    .sort((x, y) => x.debut.getTime() - y.debut.getTime())
    .slice(0, MAX_PROCHAINS)
    .map((p) => ({ ...p.b, debut: isoParis(p.debut), fin: isoParis(p.fin) }));

  // Les codes annoncés à cette borne : un zip demandé ensuite pour l'un d'eux est une mise à jour automatique
  programmesRecents.set(borne.id, { t, codes: new Set([...(actuel ? [actuel.code] : []), ...prochains.map((p) => p.code)]) });
  return { lieu: lieu ? { id: lieu.id, nom: lieu.enseigne } : null, maintenant: isoParis(maintenant), actuel, prochains };
}

// ─── Auto ou manuel ───
// La borne peut le dire (declencheur dans sa requête). Sinon on le déduit : un code reçu dans son programme dans le
// dernier quart d'heure est une mise à jour automatique ; tout autre code a été tapé à la main. En mémoire : une
// seule instance d'API, et une borne redemande son programme toutes les 5 minutes.
const programmesRecents = new Map<number, { t: number; codes: Set<string> }>();
const FENETRE_AUTO_MS = 15 * 60_000;

export function declencheurDe(borneId: number, code: string, annonce?: "auto" | "manuel" | null, maintenant = Date.now()): Declencheur {
  if (annonce) return annonce === "auto" ? "AUTO" : "MANUEL";
  const p = programmesRecents.get(borneId);
  return p && maintenant - p.t <= FENETRE_AUTO_MS && p.codes.has(code) ? "AUTO" : "MANUEL";
}

/**
 * Versions publiées de plusieurs codes (comme getEventLastUpdate du booth) : seulement les événements du lieu où la
 * borne est installée ; les autres codes sont « unknown ».
 */
export async function versionsPourBorne(borne: Pick<Borne, "id">, codes: string[], maintenant = new Date()) {
  const lieuId = await lieuDeLaBorne(borne.id, maintenant);
  const trouves = lieuId === null ? [] : await prisma.configEvenement.findMany({ where: { code: { in: codes }, lieuId }, select: { ...selectionZip, id: true, nom: true, habituel: true, reglages: true } });
  const parCode = new Map(trouves.map((e) => [e.code, e]));
  return {
    evenements: await Promise.all(
      codes.map(async (code) => {
        const e = parCode.get(code);
        return e ? await versBorne(e) : { code, status: "unknown" as const };
      })
    ),
  };
}

// ─── Journal des téléchargements ───

/**
 * Ajoute une ligne au journal (jamais bloquant pour la borne : une erreur d'écriture est seulement tracée). Un code
 * inconnu est gardé sans lien. Sans déclencheur donné, celui de la dernière demande de cette borne pour ce code (2 h).
 */
export async function noterEtape(borneId: number, d: { code: string; version: number; etat: EtatInstallation; declencheur?: Declencheur | null; message?: string | null }) {
  try {
    const trouve = await prisma.configEvenement.findUnique({ where: { code: d.code }, select: { id: true, lieuId: true } });
    // Rattaché à l'événement seulement s'il est du lieu de la borne : une borne ne peut pas écrire dans le journal d'un
    // autre lieu en déclarant son code (la ligne est gardée, sans lien, comme un code inconnu)
    const e = trouve && trouve.lieuId === (await lieuDeLaBorne(borneId, new Date())) ? trouve : null;
    let declencheur = d.declencheur ?? null;
    if (!declencheur) {
      const demande = await prisma.installationEvenement.findFirst({
        where: { borneId, code: d.code, declencheur: { not: null }, createdAt: { gt: new Date(Date.now() - 2 * 3_600_000) } },
        orderBy: { id: "desc" },
        select: { declencheur: true },
      });
      declencheur = demande?.declencheur ?? null;
    }
    await prisma.installationEvenement.create({
      data: { borneId, configEvenementId: e?.id ?? null, lieuId: e?.lieuId ?? null, code: d.code, version: d.version, etat: d.etat, declencheur, message: d.message?.slice(0, 500) ?? null },
    });
  } catch (err) {
    console.error("Journal des téléchargements :", err);
  }
}

/** Ce que la borne signale après le chargement d'un zip (TELECHARGE, INSTALLE, ECHEC). */
export const noterInstallation = (borne: Pick<Borne, "id">, d: { code: string; version: number; etat: EtatInstallation; declencheur?: Declencheur | null; message?: string | null }) => noterEtape(borne.id, d);

export interface FiltresJournal {
  lieuId?: number;
  borneId?: number;
  etat?: EtatInstallation;
  declencheur?: Declencheur;
  du?: Date;
  au?: Date;
  /** Curseur : seulement les lignes d'identifiant inférieur (page suivante) */
  avant?: bigint;
  limite: number;
  /** Périmètre de l'utilisateur sur les lieux (commercial, partenaire) */
  lieu?: Prisma.LieuWhereInput;
}

/**
 * Une page du journal, de la plus récente à la plus ancienne. Lecture par curseur sur l'identifiant (ordre
 * d'arrivée) : pas de total ni de saut de lignes, le coût ne dépend pas de la taille de la table. `suivant` : le
 * curseur de la page d'après, null à la fin.
 */
export async function lireJournal(f: FiltresJournal) {
  const lignes = await prisma.installationEvenement.findMany({
    where: {
      ...(f.avant ? { id: { lt: f.avant } } : {}),
      ...(f.lieuId ? { lieuId: f.lieuId } : {}),
      ...(f.borneId ? { borneId: f.borneId } : {}),
      ...(f.etat ? { etat: f.etat } : {}),
      ...(f.declencheur ? { declencheur: f.declencheur } : {}),
      ...(f.du || f.au ? { createdAt: { ...(f.du ? { gte: f.du } : {}), ...(f.au ? { lt: f.au } : {}) } } : {}),
      ...(f.lieu ? { evenement: { lieu: f.lieu } } : {}),
    },
    orderBy: { id: "desc" },
    take: f.limite + 1,
    select: {
      id: true, createdAt: true, code: true, version: true, etat: true, declencheur: true, message: true,
      borne: { select: { id: true, identifiant: true } },
      evenement: { select: { id: true, nom: true, habituel: true, lieu: { select: { id: true, enseigne: true, ville: true } } } },
    },
  });
  const page = lignes.slice(0, f.limite);
  return {
    lignes: page.map((l) => ({
      id: String(l.id), date: l.createdAt, code: l.code, version: l.version, etat: l.etat, declencheur: l.declencheur, message: l.message,
      borne: l.borne,
      evenement: l.evenement ? { id: l.evenement.id, nom: l.evenement.nom, parDefaut: l.evenement.habituel } : null,
      lieu: l.evenement?.lieu ?? null,
    })),
    suivant: lignes.length > f.limite ? String(page[page.length - 1].id) : null,
  };
}

/** Conservation du journal : 180 jours (appelée par le planificateur). */
export async function purgerJournal(maintenant = Date.now()) {
  const { count } = await prisma.installationEvenement.deleteMany({ where: { createdAt: { lt: new Date(maintenant - 180 * 86_400_000) } } });
  return count;
}
