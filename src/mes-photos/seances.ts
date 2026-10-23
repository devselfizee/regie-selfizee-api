import { QR_BASE_URL } from "../config-evenement/generation.js";

// Recherche des séances pour la page publique « Mes photos » (CDC page souvenir § 4.7).
// Les séances et les e-mails des invités sont chez PikCloud : tant que son API n'est pas
// branchée (PIKCLOUD_URL vide), la recherche est simulée et un seul code d'exemple répond.

/** Code de séance : 6 caractères A-Z sans I, L, O, et 2-9 (imprimé sur le tirage). */
export const FORMAT_CODE = /^[A-HJKMNP-Z2-9]{6}$/;

/** « k7px-2m » → « K7PX2M » ; null si ce n'est pas un code possible. */
export function normaliserCode(saisie: string): string | null {
  const code = saisie.toUpperCase().replace(/[\s-]/g, "");
  return FORMAT_CODE.test(code) ? code : null;
}

export const simulation = () => !process.env.PIKCLOUD_URL;

/** Code d'exemple du CDC, reconnu en simulation seulement. */
export const CODE_EXEMPLE = "K7PX2M";

/** Lien de la page souvenir d'une séance trouvée par son code (90 derniers jours), ou null. */
export async function pageSouvenirDuCode(code: string): Promise<string | null> {
  if (simulation()) {
    return code === CODE_EXEMPLE ? QR_BASE_URL.replace("#TOKEN#", `FJT5${"0".repeat(32)}`) : null;
  }
  // À brancher sur l'API PikCloud (résolution session_code → photo_uuid), dès que son contrat est connu
  return null;
}

/**
 * Demande l'envoi du lien « Toutes tes photos » à cette adresse, si des photos lui ont été envoyées.
 * Ne dit jamais si l'adresse est connue : la réponse au visiteur est toujours la même.
 */
export async function demanderLienToutesMesPhotos(email: string): Promise<void> {
  if (simulation()) {
    console.info(`Mes photos (simulation) : lien demandé pour ${email.replace(/^(.).*@/, "$1…@")}, rien n'est envoyé`);
    return;
  }
  // À brancher sur PikCloud (séances livrées à cet e-mail, lien magique 24 h)
}
