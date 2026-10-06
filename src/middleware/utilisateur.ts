import type { NextFunction, Response } from "express";
import type { User, UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import type { AuthRequest } from "./auth.js";

export interface UtilisateurRequest extends AuthRequest {
  utilisateur?: Pick<User, "id" | "email" | "nom" | "prenom" | "role" | "lieuId">;
}

export const authDesactivee = () => !process.env.KEYCLOAK_URL && process.env.NODE_ENV !== "production";

// Comptes créés automatiquement en ADMIN à leur première connexion (amorçage).
const adminsInitiaux = () =>
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

const champs = { id: true, email: true, nom: true, prenom: true, role: true, lieuId: true, isActive: true, keycloakSub: true } as const;

/**
 * Associe le compte Keycloak à un utilisateur de l'application.
 * Le realm Keycloak est partagé entre plusieurs applications : être connecté
 * ne suffit pas, il faut avoir été ajouté ici par un admin (ou figurer dans ADMIN_EMAILS).
 */
export async function utilisateurCourant(req: UtilisateurRequest, res: Response, next: NextFunction) {
  try {
    if (authDesactivee()) {
      // Dev / tests sans Keycloak : admin par défaut, ou un utilisateur précis via X-Dev-Utilisateur
      const email = req.header("X-Dev-Utilisateur")?.toLowerCase();
      if (!email) {
        req.utilisateur = { id: 0, email: "dev@local", nom: "Développeur", prenom: "", role: "ADMIN", lieuId: null };
        return next();
      }
      const u = await prisma.user.findUnique({ where: { email }, select: champs });
      if (!u?.isActive) return res.status(403).json({ error: "ACCES_NON_ACCORDE" });
      req.utilisateur = u;
      return next();
    }

    const sub = req.user?.sub;
    const email = req.user?.email?.toLowerCase();
    if (!sub) return res.status(401).json({ error: "Token invalide" });

    let u = await prisma.user.findUnique({ where: { keycloakSub: sub }, select: champs });

    // Première connexion : rattachement par e-mail à un utilisateur ajouté par un admin
    if (!u && email) {
      const parEmail = await prisma.user.findUnique({ where: { email }, select: champs });
      if (parEmail && !parEmail.keycloakSub) {
        u = await prisma.user.update({ where: { id: parEmail.id }, data: { keycloakSub: sub }, select: champs });
      } else if (!parEmail && adminsInitiaux().includes(email)) {
        u = await prisma.user.create({
          data: {
            email,
            keycloakSub: sub,
            nom: req.user?.family_name ?? email,
            prenom: req.user?.given_name ?? "",
            role: "ADMIN",
          },
          select: champs,
        });
      }
    }

    if (!u || !u.isActive) {
      return res.status(403).json({
        error: "ACCES_NON_ACCORDE",
        message: "Votre compte n'a pas accès à cette application. Demandez à un administrateur de vous ajouter.",
        email,
      });
    }
    req.utilisateur = u;
    next();
  } catch (err) {
    next(err);
  }
}

/** Restreint une route à certains rôles. */
export const exiger =
  (...roles: UserRole[]) =>
  (req: UtilisateurRequest, _res: Response, next: NextFunction) => {
    if (!req.utilisateur || !roles.includes(req.utilisateur.role)) {
      return next(new HttpError(403, "INTERDIT", "Action non autorisée pour votre rôle"));
    }
    next();
  };

/**
 * Périmètre des lieux visibles par l'utilisateur :
 * null = tous ; sinon une condition sur le commercial ou le lieu.
 */
export function perimetreLieux(u: UtilisateurRequest["utilisateur"]): { commercialId?: number; lieuId?: number } | null {
  if (!u) throw new HttpError(401, "NON_AUTHENTIFIE");
  if (u.role === "ADMIN" || u.role === "TECHNICIEN") return null;
  if (u.role === "COMMERCIAL") return { commercialId: u.id };
  return { lieuId: u.lieuId ?? -1 }; // PARTENAIRE
}

/** Vérifie que l'utilisateur peut voir ce lieu (404 sinon, pour ne pas révéler son existence). */
export async function verifierAccesLieu(u: UtilisateurRequest["utilisateur"], lieuId: number) {
  const p = perimetreLieux(u);
  if (!p) return;
  if (p.lieuId !== undefined) {
    if (p.lieuId !== lieuId) throw new HttpError(404, "INTROUVABLE");
    return;
  }
  const lieu = await prisma.lieu.findUnique({ where: { id: lieuId }, select: { commercialId: true } });
  if (!lieu || lieu.commercialId !== p.commercialId) throw new HttpError(404, "INTROUVABLE");
}
