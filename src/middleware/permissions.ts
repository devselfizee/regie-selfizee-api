// Droits Konitys — voir docs/PERMISSIONS_APP_INTEGRATION.md (port TypeScript du code de référence 5.1)
// Interroge le gateway (/api/permissions/me) avec le jeton de l'utilisateur, cache 30 s par jeton,
// applique le réglage « contrôle d'accès », fail-open — sauf le périmètre des données (peutVoirTout, mode fermé).
import type { NextFunction, Request, Response } from "express";
import { APP_KEY } from "../permissions/schema.js";
import { estCompteRegie } from "./auth.js";
import { droitsDuProfil, libellesDe, lireDroitsDuProfil, type RaisonDroitsNonLus } from "../permissions/droitsProfils.js";

const CACHE_TTL_MS = 30_000;
// Même passerelle que la photo, l'ID Hub et les notifications : une seule variable, KONITYS_GATEWAY_URL
const GATEWAY_URL = () => (process.env.KONITYS_GATEWAY_URL || "").trim().replace(/\/+$/, "");
// Sans Keycloak (développement, tests) : tout est autorisé et l'utilisateur voit tout
const sansKeycloak = () => !process.env.KEYCLOAK_URL && process.env.NODE_ENV !== "production";

export interface ReglageControle {
  globally_enabled?: boolean;
  disable_specific?: boolean;
  disabled_apps?: string[];
  enable_specific?: boolean;
  enabled_apps?: string[];
}
export interface DroitsMoi {
  user_id?: string;
  apps?: Record<string, Record<string, boolean>>;
  is_admin?: boolean;
  profiles?: number[];
  enforcement?: ReglageControle;
}

const cache = new Map<string, { at: number; data: DroitsMoi }>(); // jeton → droits

/**
 * Sans Keycloak (développement, tests) : droits simulés par l'en-tête X-Dev-Droits
 * (« * » = admin, sinon les clés accordées, séparées par des virgules), contrôle d'accès actif.
 * Sans l'en-tête, tout est autorisé et l'utilisateur voit tout. Ignoré avec Keycloak.
 */
function moiSimule(req: Request): DroitsMoi | undefined {
  const h = req.header("x-dev-droits");
  // Compte client de la Régie (X-Dev-Compte: regie) : refus par défaut, jamais admin
  if (estCompteRegie(req)) return { apps: { [APP_KEY]: Object.fromEntries((h ?? "").split(",").map((k) => k.trim()).filter((k) => k && k !== "*").map((k) => [k, true])) }, enforcement: { globally_enabled: true } };
  if (h === undefined) return undefined;
  if (h.trim() === "*") return { is_admin: true };
  const cles = h.split(",").map((k) => k.trim()).filter(Boolean);
  return { apps: { [APP_KEY]: Object.fromEntries(cles.map((k) => [k, true])) }, enforcement: { globally_enabled: true } };
}

async function chargerMoi(token: string): Promise<DroitsMoi | null> {
  const gateway = GATEWAY_URL();
  if (!token || !gateway) return null;
  try {
    const res = await fetch(`${gateway}/api/permissions/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: DroitsMoi };
    return body?.data ?? null;
  } catch (e) {
    console.warn("[perms] gateway injoignable :", (e as Error).message);
    return null;
  }
}

export async function getMe(token: string): Promise<DroitsMoi | null> {
  if (!token) return null;
  const now = Date.now();
  const enCache = cache.get(token);
  if (enCache && now - enCache.at < CACHE_TTL_MS) return enCache.data;
  const data = await chargerMoi(token);
  if (data) cache.set(token, { at: now, data });
  return data;
}

/**
 * Droits d'un compte client de la Régie (realm « regie ») : ceux du profil de l'Admin Panel attribué au compte
 * (users.profil_id), lus par la Régie avec son compte de service. Le gateway ne connaît pas ces comptes : pas de
 * /me. Refus par défaut : sans profil ou sans réponse, aucun droit ; jamais admin ; contrôle toujours actif.
 */
async function moiRegie(req: Request): Promise<DroitsMoi> {
  const profilId = (req as Request & { utilisateur?: { profilId?: number | null } }).utilisateur?.profilId;
  const droits = profilId ? await droitsDuProfil(profilId) : null;
  return { apps: { [APP_KEY]: droits ?? {} }, enforcement: { globally_enabled: true }, profiles: profilId ? [profilId] : [] };
}

/** Pourquoi un compte client n'a pas accès à la Régie : affiché sur l'écran « Accès non accordé » */
export interface DiagnosticAcces {
  code: "SANS_PROFIL" | "PROFIL_SANS_ACCES" | RaisonDroitsNonLus;
  profilId?: number;
  /** Nombre de droits « regie » lus sur le profil (PROFIL_SANS_ACCES) */
  nbDroits?: number;
  detail?: string;
}

/** Diagnostic d'un compte client sans app.access ; null s'il a l'accès */
export async function diagnosticAcces(req: Request): Promise<DiagnosticAcces | null> {
  const profilId = (req as Request & { utilisateur?: { profilId?: number | null } }).utilisateur?.profilId ?? null;
  if (sansKeycloak()) {
    const cles = await clesAccordees(req);
    return cles.includes("app.access") ? null : { code: "PROFIL_SANS_ACCES", profilId: profilId ?? undefined, nbDroits: cles.length, detail: "sans Keycloak : droits lus dans X-Dev-Droits" };
  }
  if (!profilId) return { code: "SANS_PROFIL" };
  const lecture = await lireDroitsDuProfil(profilId);
  if (!lecture.droits) return { code: lecture.raison, profilId, detail: lecture.detail };
  if (lecture.droits["app.access"] === true) return null;
  return { code: "PROFIL_SANS_ACCES", profilId, nbDroits: Object.values(lecture.droits).filter(Boolean).length };
}

/**
 * Droits de la requête : salarié → /me du gateway (null s'il ne répond pas : fail-open) ; compte régie → son profil
 * (jamais null : refus par défaut).
 */
async function moiDe(req: Request): Promise<{ me: DroitsMoi | null; ouvert: boolean }> {
  if (estCompteRegie(req)) return { me: await moiRegie(req), ouvert: false };
  const token = tokenOf(req);
  const me = await getMe(token);
  return { me, ouvert: me === null && !!token };
}

/** Clés accordées à un compte régie (pour le front, qui n'a pas le SDK du gateway) */
export async function clesAccordees(req: Request): Promise<string[]> {
  const me = sansKeycloak() ? moiSimule(req) : await moiRegie(req);
  return Object.entries(me?.apps?.[APP_KEY] ?? {}).filter(([, v]) => v === true).map(([k]) => k).sort();
}

export function tokenOf(req: Request): string {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/** Réglage « contrôle d'accès » de l'Admin Panel : actif pour cette app ? */
export function isEnforced(e: ReglageControle | undefined, appKey: string): boolean {
  if (!e) return false;
  if (e.globally_enabled) {
    if (e.disable_specific && (e.disabled_apps || []).includes(appKey)) return false;
    return true;
  }
  return !!(e.enable_specific && (e.enabled_apps || []).includes(appKey));
}

export function canForApp(me: DroitsMoi | null, appKey: string, permKey: string): boolean {
  if (!me) return true; // fail-open
  if (me.is_admin) return true; // admins Keycloak
  if (!isEnforced(me.enforcement || {}, appKey)) return true;
  return !!((me.apps || {})[appKey] || {})[permKey];
}

const REFUS = { error: "Forbidden", message: "Accès non autorisé. Contactez votre administrateur." };
const email = (req: Request) => (req as Request & { utilisateur?: { email?: string } }).utilisateur?.email ?? "?";

/** Middleware : requirePerm('lieux.create') — clé sans le préfixe de l'app */
export function requirePerm(permKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (sansKeycloak()) {
      const s = moiSimule(req);
      if (!s || canForApp(s, APP_KEY, permKey)) return next();
      return res.status(403).json(REFUS);
    }
    const { me, ouvert } = await moiDe(req);
    if (ouvert) return next(); // gateway injoignable → fail-open (salariés seulement)
    if (canForApp(me, APP_KEY, permKey)) return next();
    console.log(`[perms] ${APP_KEY}:${permKey} → REFUS (user=${email(req)})`);
    return res.status(403).json(REFUS);
  };
}

/** Middleware : requireAnyPerm('alertes.techniques_view', 'alertes.ventes_view') */
export function requireAnyPerm(...permKeys: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (sansKeycloak()) {
      const s = moiSimule(req);
      if (!s || permKeys.some((k) => canForApp(s, APP_KEY, k))) return next();
      return res.status(403).json(REFUS);
    }
    const { me, ouvert } = await moiDe(req);
    if (ouvert) return next();
    if (permKeys.some((k) => canForApp(me, APP_KEY, k))) return next();
    console.log(`[perms] ${APP_KEY}:[${permKeys.join("|")}] → REFUS (user=${email(req)})`);
    return res.status(403).json(REFUS);
  };
}

/** Vérification dans un handler, quand seul un paramètre ou une partie de la réponse est sensible */
export async function userCan(req: Request, permKey: string): Promise<boolean> {
  if (sansKeycloak()) {
    const s = moiSimule(req);
    return !s || canForApp(s, APP_KEY, permKey);
  }
  const { me, ouvert } = await moiDe(req);
  if (ouvert) return true;
  return canForApp(me, APP_KEY, permKey);
}

/** Périmètre (3.8) : vrai seulement si le gateway a répondu ET (admin OU droit accordé). Jamais de fail-open. */
export async function peutVoirTout(req: Request, permKey: string): Promise<boolean> {
  // Un compte régie ne voit jamais « tous » les lieux : seulement ceux de son entreprise qui lui sont ouverts
  if (estCompteRegie(req)) return false;
  if (sansKeycloak()) {
    const s = moiSimule(req);
    return !s || droitPerimetre(s, permKey);
  }
  const me = await getMe(tokenOf(req));
  return droitPerimetre(me, permKey);
}

/** Décision de périmètre à partir de /me (sans tenir compte du réglage « contrôle d'accès ») */
export function droitPerimetre(me: DroitsMoi | null, permKey: string): boolean {
  if (!me) return false;
  if (me.is_admin) return true;
  return ((me.apps || {})[APP_KEY] || {})[permKey] === true;
}

/** Admin de la plateforme (jeton Keycloak) : sert à des choix par défaut, jamais à autoriser */
export async function estAdminPlateforme(req: Request): Promise<boolean> {
  if (sansKeycloak()) {
    const s = moiSimule(req);
    return s ? !!s.is_admin : true;
  }
  if (estCompteRegie(req)) return false;
  return !!(await getMe(tokenOf(req)))?.is_admin;
}

/** Profils et statut admin de l'utilisateur connecté, d'après /me ; null si le gateway n'a pas répondu (rien à relever) */
export async function profilsDuJeton(req: Request): Promise<{ profils: number[]; admin: boolean } | null> {
  if (sansKeycloak() || estCompteRegie(req)) return null;
  const me = await getMe(tokenOf(req));
  if (!me) return null;
  return { profils: [...new Set((me.profiles ?? []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b), admin: !!me.is_admin };
}

/** Libellés des profils de l'Admin Panel (id → nom), lus avec le jeton de l'admin qui consulte ; vide si indisponible */
export async function libellesProfils(req: Request): Promise<Record<number, string>> {
  const gateway = GATEWAY_URL();
  const token = tokenOf(req);
  if (!gateway || !token) return {};
  try {
    const r = await fetch(`${gateway}/api/permissions/profiles`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return {};
    return libellesDe(await r.json());
  } catch {
    return {};
  }
}

export function invalidatePermsCache() {
  cache.clear();
}

export { APP_KEY };
