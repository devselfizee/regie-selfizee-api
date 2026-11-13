// Super admins de la Régie : les e-mails de ADMIN_EMAILS (séparés par des virgules, variable Coolify), seuls à pouvoir
// supprimer un lieu ou une borne et à voir la liste de tous les événements (demandes du 13/11). Tout admin Konitys a tous les droits de l'application : une liste
// d'e-mails est le seul moyen de réserver ce geste à quelques personnes. Écart voulu à docs/PERMISSIONS_APP_INTEGRATION.md
// (3.7), limité à ces gestes. Variable vide ou absente : personne.

import type { RequestHandler } from "express";
import { HttpError } from "./http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";

export function estSuperAdmin(email: string | null | undefined, valeur = process.env.ADMIN_EMAILS): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return false;
  return (valeur ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .includes(e);
}

/** Route réservée aux super admins : 403 pour tous les autres, admins Konitys compris */
export const exigerSuperAdmin: RequestHandler = (req, _res, next) => {
  if (!estSuperAdmin((req as UtilisateurRequest).utilisateur?.email)) return next(new HttpError(403, "SUPER_ADMIN_REQUIS", "Réservé aux super admins."));
  next();
};
