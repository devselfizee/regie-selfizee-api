import { TZDate } from "@date-fns/tz";
import type { Borne, EtatInstallation } from "@prisma/client";
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
  const ponctuels = await Promise.all(
    evenements
      .filter((e) => !e.habituel)
      .map(async (e) => {
        const l = reglagesSchema.parse(e.reglages).lieu;
        return { e, b: await versBorne(e), debut: instantParis(l.dateDebut, l.heureDebut, false), fin: instantParis(l.dateFin, l.heureFin, true) };
      })
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

  return { lieu: lieu ? { id: lieu.id, nom: lieu.enseigne } : null, maintenant: isoParis(maintenant), actuel, prochains };
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

/** Ce que la borne signale après le chargement d'un zip. Un code inconnu est gardé (sans lien) : rien n'est perdu. */
export async function noterInstallation(borne: Pick<Borne, "id">, d: { code: string; version: number; etat: EtatInstallation; message?: string | null }) {
  const e = await prisma.configEvenement.findUnique({ where: { code: d.code }, select: { id: true } });
  await prisma.installationEvenement.create({
    data: { borneId: borne.id, configEvenementId: e?.id ?? null, code: d.code, version: d.version, etat: d.etat, message: d.message?.slice(0, 500) ?? null },
  });
}
