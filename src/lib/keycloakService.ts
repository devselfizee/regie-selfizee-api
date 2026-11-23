// Jetons de service Keycloak (client_credentials), gardés jusqu'à 30 s avant leur expiration.
// - konitys : compte de service qui lit les droits des profils de l'Admin Panel (comptes clients de la Régie) ;
// - regie : compte de service qui crée et invite les comptes clients dans le realm « regie ».
// Identifiants dans les variables d'environnement (Coolify), jamais dans le code.

const KEYCLOAK_URL = () => (process.env.KEYCLOAK_URL || "").trim().replace(/\/+$/, "");

interface Identifiants {
  realm: string;
  clientId: string;
  secret: string;
}

const cache = new Map<string, { jeton: string; expire: number }>();

/** Jeton de service pour ces identifiants, ou null (non configuré, Keycloak injoignable, refus) */
export async function jetonService(id: Identifiants | null, maintenant = Date.now()): Promise<string | null> {
  const base = KEYCLOAK_URL();
  if (!id || !base) return null;
  const cle = `${id.realm}|${id.clientId}`;
  const enCache = cache.get(cle);
  if (enCache && enCache.expire > maintenant) return enCache.jeton;
  try {
    const r = await fetch(`${base}/realms/${encodeURIComponent(id.realm)}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: id.clientId, client_secret: id.secret }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const corps = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!corps.access_token) throw new Error("pas de jeton");
    cache.set(cle, { jeton: corps.access_token, expire: maintenant + Math.max(0, (corps.expires_in ?? 60) - 30) * 1000 });
    return corps.access_token;
  } catch (e) {
    console.warn(`[keycloak] jeton de service ${id.realm}/${id.clientId} non obtenu :`, (e as Error).message);
    return null;
  }
}

const lire = (realm: string | undefined, clientId: string | undefined, secret: string | undefined): Identifiants | null =>
  realm?.trim() && clientId?.trim() && secret?.trim() ? { realm: realm.trim(), clientId: clientId.trim(), secret: secret.trim() } : null;

/** Compte de service du realm konitys qui lit les profils et leurs droits (gateway /api/permissions/profiles…) */
export const serviceDroits = () => lire(process.env.KEYCLOAK_REALM || "konitys", process.env.KONITYS_DROITS_CLIENT_ID, process.env.KONITYS_DROITS_CLIENT_SECRET);

/** Compte de service du realm « regie » qui gère les comptes clients (API admin de Keycloak) */
export const serviceComptesRegie = () => lire(process.env.KEYCLOAK_REGIE_REALM, process.env.KEYCLOAK_REGIE_ADMIN_CLIENT_ID, process.env.KEYCLOAK_REGIE_ADMIN_CLIENT_SECRET);

export function viderJetonsService() {
  cache.clear();
}
