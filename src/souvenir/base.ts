import type { Request } from "express";
import { QR_BASE_URL } from "../config-evenement/generation.js";

// Adresses publiques utilisées dans les URLs et les mails de la page souvenir.

let derniereBase: string | null = null;

/**
 * Base absolue des URLs de fichiers : celle que le navigateur de l'invité peut joindre (SOUVENIR_URL_FICHIERS, à défaut
 * l'hôte de la requête authentifiée du serveur de la page souvenir, retenu pour les mails envoyés en tâche de fond).
 */
export function baseFichiers(req: Request): string {
  const base = (process.env.SOUVENIR_URL_FICHIERS || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  derniereBase = base;
  return base;
}

/** Base publique de cette API pour les mails (aperçu de la photo, liens suivis) ; null tant qu'elle est inconnue. */
export const basePublique = (): string | null => process.env.SOUVENIR_URL_FICHIERS?.replace(/\/+$/, "") || derniereBase;

/** Adresse de la page souvenir déployée (SOUVENIR_PAGE_URL, à défaut l'origine de SOUVENIR_QR_BASE_URL). */
export function adressePage(): string {
  const v = process.env.SOUVENIR_PAGE_URL?.trim();
  if (v) return v.replace(/\/+$/, "");
  try {
    return new URL(QR_BASE_URL.replace("#TOKEN#", "x")).origin;
  } catch {
    return "https://myevent.selfizee.fr";
  }
}
