// Droits d'un profil de l'Admin Panel, pour les comptes clients de la Régie (realm « regie », option 2 du 20/11/2026).
// Le gateway ne connaît pas ces comptes : la Régie lit, avec son compte de service, les droits « regie » du profil
// attribué au compte et des profils qu'il inclut (composition). Cache 5 min. Refus par défaut : null en cas de doute.

import { jetonService, serviceDroits } from "../lib/keycloakService.js";
import { APP_KEY } from "./schema.js";

const GATEWAY_URL = () => (process.env.KONITYS_GATEWAY_URL || "").trim().replace(/\/+$/, "");
const TTL_MS = 5 * 60_000;
const PROFONDEUR_MAX = 5;

const cache = new Map<number, { at: number; droits: Record<string, boolean> }>();

const deData = (corps: unknown): unknown => (corps && typeof corps === "object" && "data" in corps ? (corps as { data: unknown }).data : corps);

/**
 * Droits « regie » dans la réponse de GET /api/permissions/profiles/:id/permissions. La forme exacte n'est pas
 * documentée au-delà de `{ app_key, grants }` : on accepte aussi une liste de ces objets, `{ apps: { regie: {…} } }`
 * et `{ regie: {…} }`. Seules les valeurs `true` comptent.
 */
export function grantsRegie(corps: unknown, app = APP_KEY): Record<string, boolean> {
  const d = deData(corps);
  const vrais = (g: unknown) =>
    g && typeof g === "object" ? Object.fromEntries(Object.entries(g as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => [k, true])) : {};
  const elements = Array.isArray(d) ? d : [d];
  const droits: Record<string, boolean> = {};
  for (const e of elements) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (o.app_key === app) Object.assign(droits, vrais(o.grants ?? o.permissions));
    else if (o.apps && typeof o.apps === "object") Object.assign(droits, vrais((o.apps as Record<string, unknown>)[app]));
    else if (!("app_key" in o) && o[app] && typeof o[app] === "object") Object.assign(droits, vrais(o[app]));
  }
  return droits;
}

/** Profils inclus d'après GET /api/permissions/profiles/:id/composition : ids, ou objets { id | profile_id | child_id } */
export function profilsInclus(corps: unknown): number[] {
  const d = deData(corps);
  const liste = Array.isArray(d) ? d : d && typeof d === "object" ? ((d as Record<string, unknown>).profiles ?? (d as Record<string, unknown>).children ?? (d as Record<string, unknown>).includes ?? []) : [];
  if (!Array.isArray(liste)) return [];
  return [
    ...new Set(
      liste
        .map((x) => (typeof x === "object" && x ? ((x as Record<string, unknown>).child_id ?? (x as Record<string, unknown>).profile_id ?? (x as Record<string, unknown>).id) : x))
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
    ),
  ];
}

async function lireJson(chemin: string, jeton: string): Promise<unknown> {
  const r = await fetch(`${GATEWAY_URL()}${chemin}`, { headers: { Authorization: `Bearer ${jeton}` }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${chemin} : HTTP ${r.status}`);
  return r.json();
}

/**
 * Droits « regie » accordés par ce profil (et ses profils inclus), ou null si on ne peut pas les lire : la Régie
 * refuse alors tout au compte. `lecteur` remplaçable pour les tests.
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
    const droits: Record<string, boolean> = {};
    const vus = new Set<number>();
    let niveau = [profilId];
    for (let profondeur = 0; niveau.length && profondeur < PROFONDEUR_MAX; profondeur++) {
      const suivant: number[] = [];
      for (const id of niveau) {
        if (vus.has(id)) continue;
        vus.add(id);
        Object.assign(droits, grantsRegie(await lire(`/api/permissions/profiles/${id}/permissions?app_key=${APP_KEY}`)));
        // Composition : une erreur ici ne retire pas les droits propres du profil
        const inclus = await lire(`/api/permissions/profiles/${id}/composition`).then(profilsInclus, () => []);
        suivant.push(...inclus);
      }
      niveau = suivant;
    }
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

/** Réponse de GET /api/permissions/profiles → id → nom */
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
