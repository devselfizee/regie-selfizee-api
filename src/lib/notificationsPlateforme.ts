// Notifications de la plateforme Konitys (la cloche de l'en-tête commun) : POST /api/notifications de la passerelle,
// authentifié par ws_token. Sans jeton configuré, rien n'est envoyé (les e-mails, eux, partent quand même).
const URL_NOTIFICATIONS = () => (process.env.KONITYS_NOTIFICATIONS_URL || "https://plateform-gateway.orkessidev.com/api/notifications").trim();
const JETON = () => (process.env.KONITYS_WS_TOKEN ?? "").trim();
// Origine affichée par la plateforme ; « regie » par défaut, réglable si la plateforme impose une liste
const ORIGINE = () => (process.env.KONITYS_NOTIFICATIONS_ORIGINE || "regie").trim();

export const notificationsPlateformeConfigurees = () => !!JETON();

export interface NotificationPlateforme {
  /** Identifiant de l'utilisateur sur la plateforme (pas celui de la Régie) */
  destinataire: number;
  titre: string;
  contenu?: string;
  /** Clé unique : la plateforme ignore un doublon */
  cle?: string;
  entityId?: string;
  url?: string;
}

/** Corps de la requête, au format de la plateforme */
export function corpsNotification(n: NotificationPlateforme, origine = ORIGINE()) {
  return {
    titre: n.titre.slice(0, 255),
    ...(n.contenu ? { contenu: n.contenu } : {}),
    ...(n.cle ? { cle: n.cle } : {}),
    origine,
    ...(n.entityId ? { entity_id: n.entityId } : {}),
    ...(n.url ? { url: n.url } : {}),
    recipient_type: "user",
    recipient_user_id: n.destinataire,
  };
}

/** Envoie une notification ; rend l'erreur en texte (null si envoyée ou si non configuré), sans jamais lever */
export async function envoyerNotificationPlateforme(n: NotificationPlateforme): Promise<string | null> {
  if (!notificationsPlateformeConfigurees()) return null;
  const url = new URL(URL_NOTIFICATIONS());
  url.searchParams.set("ws_token", JETON());
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpsNotification(n)),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return `HTTP ${r.status} : ${(await r.text()).slice(0, 200)}`;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
