// Droits d'un profil de l'Admin Panel, pour les comptes clients de la Régie (realm « regie », option 2 du 20/11/2026).
// Le gateway ne connaît pas ces comptes : la Régie lit, avec son compte de service, les droits « regie » du profil
// attribué au compte. Cache 5 min. Refus par défaut : null en cas de doute.
//
// Réponse du gateway (confirmée par la plateforme le 23/11/2026) pour GET /api/permissions/profiles/:id/permissions :
//   { data: { direct:    { <app_key>: { <clé>: true | false } },
//             inherited: { <app_key>: { <clé>: [ { id, name } ] } } } }
// - direct : droits posés sur le profil (false = refus explicite) ;
// - inherited : droits accordés par les profils inclus, déjà calculés sur toute la descendance (que des accords).
// Un droit est effectif s'il vaut true dans direct ou s'il est présent dans inherited. `?app_key=` est ignoré par le
// gateway : on lit data.direct.regie et data.inherited.regie. Profil inexistant : direct {} (pas de 404) → aucun droit.

import { jetonService, serviceDroits } from "../lib/keycloakService.js";
import { APP_KEY } from "./schema.js";

const GATEWAY_URL = () => (process.env.KONITYS_GATEWAY_URL || "").trim().replace(/\/+$/, "");
const TTL_MS = 5 * 60_000;

const cache = new Map<number, { at: number; droits: Record<string, boolean> }>();

const deData = (corps: unknown): unknown => (corps && typeof corps === "object" && "data" in corps ? (corps as { data: unknown }).data : corps);
const objet = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Droits « regie » effectifs d'après la réponse de GET /api/permissions/profiles/:id/permissions (voir en-tête) */
export function grantsRegie(corps: unknown, app = APP_KEY): Record<string, boolean> {
  const d = objet(deData(corps));
  if (!d) return {};
  const droits: Record<string, boolean> = {};
  for (const [cle, v] of Object.entries(objet(objet(d.direct)?.[app]) ?? {})) if (v === true) droits[cle] = true;
  for (const [cle, v] of Object.entries(objet(objet(d.inherited)?.[app]) ?? {})) if (v === true || (Array.isArray(v) && v.length)) droits[cle] = true;
  return droits;
}

async function lireJson(chemin: string, jeton: string): Promise<unknown> {
  const r = await fetch(`${GATEWAY_URL()}${chemin}`, { headers: { Authorization: `Bearer ${jeton}` }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${chemin} : HTTP ${r.status}`);
  return r.json();
}

/**
 * Droits « regie » accordés par ce profil (hérités compris), ou null si on ne peut pas les lire : la Régie refuse
 * alors tout au compte. `lecteur` remplaçable pour les tests.
 */
export async function droitsDuProfil(
  profilId: number,
  lecteur?: (chemin: string) => Promise<unknown>,
  maintenant = Date.now()
): Promise<Record<string, boolean> | null> {
  const enCache = cache.get(profilId);
  if (enCache && maintenant - enCache.at < TTL_MS) return enCache.droits;
  let lire = lecteur;
  if (!lire) {
    if (!GATEWAY_URL()) return null;
    const jeton = await jetonService(serviceDroits());
    if (!jeton) return null;
    lire = (chemin) => lireJson(chemin, jeton);
  }
  try {
    const droits = grantsRegie(await lire(`/api/permissions/profiles/${profilId}/permissions`));
    cache.set(profilId, { at: maintenant, droits });
    return droits;
  } catch (e) {
    console.warn(`[perms] droits du profil ${profilId} non lus (compte régie : aucun droit) :`, (e as Error).message);
    return null;
  }
}

/** Libellés des profils (id → nom) lus avec le compte de service ; vide si indisponible */
export async function libellesProfilsService(): Promise<Record<number, string>> {
  if (!GATEWAY_URL()) return {};
  const jeton = await jetonService(serviceDroits());
  if (!jeton) return {};
  try {
    return libellesDe(await lireJson("/api/permissions/profiles", jeton));
  } catch {
    return {};
  }
}

/** Réponse de GET /api/permissions/profiles (ou /composition : { id, nom, alias }) → id → nom */
export function libellesDe(corps: unknown): Record<number, string> {
  const d = deData(corps);
  const liste = (Array.isArray(d) ? d : []) as Record<string, unknown>[];
  const nom = (p: Record<string, unknown>) => [p.libelle, p.label, p.nom, p.name, p.titre].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return Object.fromEntries(liste.filter((p) => p && Number.isInteger(Number(p.id)) && nom(p)).map((p) => [Number(p.id), nom(p)!]));
}

/** Profils qu'on peut attribuer à un compte client : REGIE_PROFILS_CLIENTS (ids séparés par des virgules) */
export function profilsClientsAutorises(valeur = process.env.REGIE_PROFILS_CLIENTS): number[] {
  return [...new Set((valeur ?? "").split(/[,;\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

export function viderCacheProfils() {
  cache.clear();
}
