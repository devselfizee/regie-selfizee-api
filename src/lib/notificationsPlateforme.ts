// Notifications de la cloche de la topbar Konitys (guide « notifications topbar pour apps », 06/11/2026) :
// POST {KONITYS_GATEWAY_URL}/api/notifications, authentifié par le jeton Keycloak de l'utilisateur qui agit (relayé).
// Jamais bloquant : une notification ne fait pas échouer l'action, on journalise seulement.
const GATEWAY = () => (process.env.KONITYS_GATEWAY_URL || "https://plateform-gateway.orkessi.com").trim().replace(/\/+$/, "");
// Slug de l'app, filtre côté Hub
const ORIGINE = () => (process.env.KONITYS_APP_SLUG || "regie").trim();

/** ID Hub d'un utilisateur fédéré : dernier segment du sub Keycloak « f:<componentId>:<idHub> » ; null sinon */
export function idHub(sub: string | null | undefined): number | null {
  if (!sub?.startsWith("f:")) return null;
  const id = Number(sub.split(":").pop());
  return Number.isInteger(id) && id > 0 ? id : null;
}

export interface NotificationPlateforme {
  /** ID de l'utilisateur dans le Hub (pas celui de la Régie) */
  destinataire: number;
  titre: string;
  contenu?: string;
  /** Étiquette libre : ne déduplique pas côté Hub */
  cle?: string;
  entityId?: string;
  /** URL absolue ouverte au clic */
  url?: string;
}

/** Corps de la requête, au format du Gateway */
export function corpsNotification(n: NotificationPlateforme, origine = ORIGINE()) {
  return {
    titre: n.titre.slice(0, 255),
    contenu: n.contenu ?? "",
    url: n.url ?? "",
    origine,
    entity_id: n.entityId ?? "",
    cle: n.cle ?? "",
    recipient_type: "user",
    recipient_user_id: n.destinataire,
  };
}

/** Envoie la notification avec le jeton (« Bearer … ») de l'utilisateur qui agit ; rend l'erreur en texte, null si envoyée */
export async function envoyerNotificationPlateforme(autorisation: string | undefined, n: NotificationPlateforme): Promise<string | null> {
  if (!autorisation?.startsWith("Bearer ")) return "pas de jeton utilisateur à relayer";
  try {
    const r = await fetch(`${GATEWAY()}/api/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: autorisation },
      body: JSON.stringify(corpsNotification(n)),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok ? null : `HTTP ${r.status} : ${(await r.text()).slice(0, 200)}`;
  } catch (e) {
    return (e as Error).message;
  }
}
