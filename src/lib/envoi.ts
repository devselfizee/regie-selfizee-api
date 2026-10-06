// Envoi d'e-mails (Mailjet) et de SMS (SMSEnvoi) : les mêmes services que le CRM Selfizee.
// Sans identifiants configurés, rien n'est envoyé : l'envoi est seulement journalisé,
// et la fonction renvoie le motif (tracé dans notifications_alerte).

/** Envoie un e-mail. Renvoie null si l'envoi a réussi, sinon le motif de l'échec. */
export async function envoyerEmail(destinataire: string, sujet: string, html: string): Promise<string | null> {
  const cle = process.env.MAILJET_API_KEY;
  const secret = process.env.MAILJET_API_SECRET;
  if (!cle || !secret) {
    console.log(`[e-mail non envoyé — MAILJET_API_KEY / MAILJET_API_SECRET absents] ${destinataire} : ${sujet}`);
    return "Envoi désactivé (MAILJET_API_KEY / MAILJET_API_SECRET non configurés)";
  }
  const res = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cle}:${secret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Messages: [
        {
          From: { Email: process.env.NOTIF_EXPEDITEUR_EMAIL ?? "alertes@selfizee.fr", Name: process.env.NOTIF_EXPEDITEUR_NOM ?? "Régie Selfizee" },
          To: [{ Email: destinataire }],
          Subject: sujet,
          HTMLPart: html,
        },
      ],
    }),
  });
  if (!res.ok) return `Mailjet ${res.status} : ${(await res.text()).slice(0, 300)}`;
  const corps = (await res.json()) as { Messages?: { Status?: string; Errors?: { ErrorMessage?: string }[] }[] };
  const m = corps.Messages?.[0];
  return m?.Status === "success" ? null : `Mailjet : ${m?.Errors?.map((e) => e.ErrorMessage).join(", ") ?? "échec"}`;
}

/** Numéro français → format international sans « + » (0612… → 33612…), comme le CRM. */
export const numeroInternational = (tel: string) => {
  const chiffres = tel.replace(/[^\d+]/g, "");
  if (chiffres.startsWith("+")) return chiffres.slice(1);
  if (chiffres.startsWith("00")) return chiffres.slice(2);
  if (chiffres.startsWith("0")) return `33${chiffres.slice(1)}`;
  return chiffres;
};

/** Envoie un SMS par SMSEnvoi (API HTTP, mêmes paramètres que le CRM). */
export async function envoyerSms(telephone: string, texte: string): Promise<string | null> {
  const email = process.env.SMSENVOI_EMAIL;
  const apikey = process.env.SMSENVOI_APIKEY;
  if (!email || !apikey) {
    console.log(`[SMS non envoyé — SMSENVOI_EMAIL / SMSENVOI_APIKEY absents] ${telephone} : ${texte}`);
    return "Envoi désactivé (SMSENVOI_EMAIL / SMSENVOI_APIKEY non configurés)";
  }
  const champs = new URLSearchParams({
    email,
    apikey,
    version: "3.0.4",
    "message[recipients]": numeroInternational(telephone),
    "message[content]": texte.slice(0, 300),
    "message[subtype]": "PREMIUM",
    "message[senderlabel]": (process.env.SMS_EXPEDITEUR ?? "SELFIZEE").slice(0, 11),
  });
  const res = await fetch("https://www.smsenvoi.com/httpapi/sendsms/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: champs,
  });
  const brut = await res.text();
  try {
    const r = JSON.parse(brut) as { success?: number | string; message?: string };
    return Number(r.success) === 1 ? null : `SMSEnvoi : ${r.message ?? "échec"}`;
  } catch {
    return `SMSEnvoi ${res.status} : ${brut.slice(0, 200)}`;
  }
}
