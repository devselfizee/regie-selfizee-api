// Droits Konitys — voir docs/PERMISSIONS_APP_INTEGRATION.md (port TypeScript du code de référence 5.1)
// Interroge le gateway (/api/permissions/me) avec le jeton de l'utilisateur, cache 30 s par jeton,
// applique le réglage « contrôle d'accès », fail-open — sauf le périmètre des données (peutVoirTout, mode fermé).
import type { NextFunction, Request, Response } from "express";
import { APP_KEY } from "../permissions/schema.js";

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
    const token = tokenOf(req);
    const me = await getMe(token);
    if (me === null && token) return next(); // gateway injoignable → fail-open
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
    const token = tokenOf(req);
    const me = await getMe(token);
    if (me === null && token) return next();
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
  const token = tokenOf(req);
  const me = await getMe(token);
  if (me === null && token) return true;
  return canForApp(me, APP_KEY, permKey);
}

/** Périmètre (3.8) : vrai seulement si le gateway a répondu ET (admin OU droit accordé). Jamais de fail-open. */
export async function peutVoirTout(req: Request, permKey: string): Promise<boolean> {
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
  return !!(await getMe(tokenOf(req)))?.is_admin;
}

export function invalidatePermsCache() {
  cache.clear();
}

export { APP_KEY };
