// Comptes clients de la Régie dans le realm Keycloak « regie » (option 2 du 20/11/2026), par l'API admin de Keycloak
// et le compte de service KEYCLOAK_REGIE_ADMIN_CLIENT_ID. La Régie crée le compte, envoie l'invitation (le client
// choisit son mot de passe et confirme son e-mail), l'active ou le désactive. Elle ne modifie jamais son identité
// après la création : le client la tient lui-même dans son compte Keycloak.

import { HttpError } from "./http.js";
import { jetonService, serviceComptesRegie } from "./keycloakService.js";

const KEYCLOAK_URL = () => (process.env.KEYCLOAK_URL || "").trim().replace(/\/+$/, "");
const REALM = () => (process.env.KEYCLOAK_REGIE_REALM || "").trim();
// Client public du front dans le realm « regie » : le lien de l'invitation ramène sur la Régie
const CLIENT_FRONT = () => (process.env.KEYCLOAK_REGIE_FRONT_CLIENT_ID || "regie-selfizee").trim();
const APP_URL = () => (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
const ACTIONS = ["UPDATE_PASSWORD", "VERIFY_EMAIL"];
// Validité du lien d'invitation : 7 jours
const DUREE_INVITATION_S = 7 * 86_400;

export const comptesRegieConfigures = () => Boolean(KEYCLOAK_URL() && REALM() && serviceComptesRegie());

async function appel(chemin: string, init: RequestInit = {}): Promise<Response> {
  if (!comptesRegieConfigures()) throw new HttpError(503, "COMPTES_CLIENTS_NON_CONFIGURES", "La connexion des clients (realm « regie ») n'est pas encore configurée.");
  const jeton = await jetonService(serviceComptesRegie());
  if (!jeton) throw new HttpError(502, "KEYCLOAK_INDISPONIBLE", "Keycloak ne répond pas : réessayez dans un instant.");
  return fetch(`${KEYCLOAK_URL()}/admin/realms/${encodeURIComponent(REALM())}${chemin}`, {
    ...init,
    headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
}

async function echec(r: Response, quoi: string): Promise<never> {
  const texte = await r.text().catch(() => "");
  console.warn(`[keycloak regie] ${quoi} : HTTP ${r.status} ${texte.slice(0, 300)}`);
  throw new HttpError(502, "KEYCLOAK_ERREUR", `Keycloak a refusé : ${quoi}.`);
}

/** Identifiant Keycloak (sub) du compte de cet e-mail dans le realm « regie », ou null */
export async function chercherCompte(email: string): Promise<string | null> {
  const r = await appel(`/users?email=${encodeURIComponent(email)}&exact=true`);
  if (!r.ok) await echec(r, "recherche du compte");
  const liste = (await r.json()) as { id?: string; email?: string }[];
  return liste.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id ?? null;
}

/** Crée le compte (ou retrouve celui qui existe déjà pour cet e-mail) et renvoie son identifiant Keycloak */
export async function creerCompte(c: { email: string; prenom: string; nom: string }): Promise<string> {
  const r = await appel("/users", {
    method: "POST",
    body: JSON.stringify({ username: c.email, email: c.email, firstName: c.prenom, lastName: c.nom, enabled: true, emailVerified: false, requiredActions: ACTIONS }),
  });
  if (r.status === 409) {
    const id = await chercherCompte(c.email);
    if (id) return id;
  }
  if (!r.ok && r.status !== 409) await echec(r, "création du compte");
  const id = r.headers.get("location")?.split("/").pop() || (await chercherCompte(c.email));
  if (!id) throw new HttpError(502, "KEYCLOAK_ERREUR", "Compte créé mais introuvable dans Keycloak.");
  return id;
}

/** Envoie (ou renvoie) l'e-mail d'invitation : choix du mot de passe et confirmation de l'adresse */
export async function envoyerInvitation(keycloakId: string): Promise<void> {
  const q = new URLSearchParams({ client_id: CLIENT_FRONT(), lifespan: String(DUREE_INVITATION_S), ...(APP_URL() ? { redirect_uri: `${APP_URL()}/?compte=client` } : {}) });
  const r = await appel(`/users/${encodeURIComponent(keycloakId)}/execute-actions-email?${q}`, { method: "PUT", body: JSON.stringify(ACTIONS) });
  if (!r.ok) await echec(r, "envoi de l'invitation");
}

/** Active ou désactive le compte (la connexion est refusée par Keycloak lui-même) */
export async function activerCompte(keycloakId: string, actif: boolean): Promise<void> {
  const r = await appel(`/users/${encodeURIComponent(keycloakId)}`, { method: "PUT", body: JSON.stringify({ enabled: actif }) });
  if (!r.ok) await echec(r, actif ? "réactivation du compte" : "désactivation du compte");
}
