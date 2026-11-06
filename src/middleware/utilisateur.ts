import type { NextFunction, Response } from "express";
import type { User, UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import type { AuthRequest } from "./auth.js";
import { reglagesComptes, reglagesComptesDefaut } from "../lib/reglagesComptes.js";

export interface UtilisateurRequest extends AuthRequest {
  utilisateur?: Pick<User, "id" | "email" | "nom" | "prenom" | "role" | "lieuId">;
}

export const authDesactivee = () => !process.env.KEYCLOAK_URL && process.env.NODE_ENV !== "production";

// Comptes créés automatiquement en ADMIN à leur première connexion (amorçage).
// Tolérant aux erreurs de saisie courantes dans Coolify : guillemets, "ADMIN_EMAILS=" collé dans la valeur.
export const adminsInitiaux = (brut = process.env.ADMIN_EMAILS ?? "") =>
  brut
    .replace(/^\s*ADMIN_EMAILS\s*=/i, "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter((e) => e.includes("@"));

const champs = { id: true, email: true, nom: true, prenom: true, telephone: true, role: true, lieuId: true, isActive: true, keycloakSub: true, photoVerifieeLe: true, plateformeUserId: true, roleKeycloak: true, rolesJeton: true } as const;

// Photo du compte sur la plateforme Konitys (celle de l'en-tête), relevée au plus toutes les 12 h
const GATEWAY_KONITYS = (process.env.KONITYS_GATEWAY_URL || "https://plateform-gateway.orkessi.com").replace(/\/+$/, "");
const PLATEFORME_KONITYS = (process.env.KONITYS_PLATEFORME_URL || "https://plateform.orkessi.com").replace(/\/+$/, "");
const PHOTO_VALIDE_MS = 12 * 3_600_000;

/** Identifiant de l'utilisateur sur la plateforme d'après la réponse de /api/users/me, ou null */
export function idPlateforme(reponse: unknown): number | null {
  const r = reponse as { data?: { data?: { id?: unknown }; id?: unknown }; id?: unknown } | null;
  const id = Number((r?.data?.data ?? r?.data ?? r)?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Téléphone de la fiche Hub (/api/users/me), pour les alertes SMS : Keycloak et le Hub ont les mêmes utilisateurs,
 * le Hub est la source. Null s'il n'y en a pas (le numéro déjà connu est alors gardé).
 */
export function telephoneHub(reponse: unknown, champs = reglagesComptesDefaut().champsTelephone): string | null {
  const r = reponse as { data?: { data?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>;
  const d = (r?.data?.data ?? r?.data ?? r) as Record<string, unknown> | undefined;
  for (const champ of champs) {
    const v = d?.[champ];
    if (typeof v === "string" && v.replace(/\D/g, "").length >= 6) return v.trim();
  }
  return null;
}

/** URL de la photo d'après la réponse de /api/users/me de la plateforme (photo_nom), ou null */
export function urlPhotoKonitys(reponse: unknown, base = PLATEFORME_KONITYS): string | null {
  const r = reponse as { data?: { data?: { photo_nom?: unknown }; photo_nom?: unknown }; photo_nom?: unknown } | null;
  const d = r?.data?.data ?? r?.data ?? r;
  const nom = (d as { photo_nom?: unknown } | undefined)?.photo_nom;
  return typeof nom === "string" && nom.trim() ? `${base}/uploads/contacts/${encodeURIComponent(nom.trim())}` : null;
}

/** Relève la photo du compte avec le jeton de la personne, sans retarder la requête ; une panne de la plateforme ne bloque rien */
function releverPhoto(userId: number, autorisation: string, champsTelephone: string[]) {
  fetch(`${GATEWAY_KONITYS}/api/users/me`, { headers: { Authorization: autorisation }, signal: AbortSignal.timeout(5000) })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const moi = await r.json();
      const plateformeUserId = idPlateforme(moi);
      const telephone = telephoneHub(moi, champsTelephone);
      await prisma.user.update({
        where: { id: userId },
        data: {
          photoUrl: urlPhotoKonitys(moi),
          photoVerifieeLe: new Date(),
          ...(plateformeUserId ? { plateformeUserId } : {}),
          ...(telephone ? { telephone } : {}),
        },
      });
    })
    .catch(async (err) => {
      console.warn("Photo du compte Konitys non relevée :", (err as Error).message);
      // On réessaiera dans 12 h, pas à chaque requête
      await prisma.user.update({ where: { id: userId }, data: { photoVerifieeLe: new Date() } }).catch(() => undefined);
    });
}

/** Identité tenue dans Keycloak (nom, prénom, téléphone) : Régie la recopie, ne la modifie jamais. Seuls les champs présents dans le jeton. */
export function identiteKeycloak(jeton: AuthRequest["user"]): { nom?: string; prenom?: string; telephone?: string } {
  const t = (v?: string) => v?.trim() || undefined;
  return Object.fromEntries(
    Object.entries({ nom: t(jeton?.family_name), prenom: t(jeton?.given_name), telephone: t(jeton?.phone_number) }).filter(([, v]) => v !== undefined)
  );
}

// Noms de rôles Keycloak (realm ou client) qui donnent le rôle ADMIN ici, sans tenir compte de la casse
export const rolesAdminKeycloak = (brut = process.env.KEYCLOAK_ROLES_ADMIN || "admin,administrateur,administrator,super-admin,super_admin,superadmin") =>
  brut.split(/[,;\s]+/).map((r) => r.trim().toLowerCase()).filter(Boolean);

/**
 * Rôles Keycloak (realm ou client, sans tenir compte de la casse) qui donnent chaque rôle de la Régie.
 * Keycloak est la source des rôles (retour de Sébastien) ; noms réglables par variable d'environnement.
 * Ordre de priorité : un compte qui a plusieurs rôles prend le plus large.
 */
const PRIORITE: UserRole[] = ["ADMIN", "TECHNICIEN", "COMMERCIAL", "PARTENAIRE"];

/** Rôle de la Régie d'après les rôles du jeton Keycloak (correspondance réglée dans Paramètres) ; null si aucun */
export function roleKeycloak(jeton: AuthRequest["user"], correspondance: Record<UserRole, string[]> = reglagesComptesDefaut().roles): UserRole | null {
  const roles = new Set([...(jeton?.realm_access?.roles ?? []), ...Object.values(jeton?.resource_access ?? {}).flatMap((c) => c.roles ?? [])].map((r) => r.toLowerCase()));
  return PRIORITE.find((r) => (correspondance[r] ?? []).some((n) => roles.has(n.toLowerCase()))) ?? null;
}

/** Le jeton porte-t-il un rôle admin, au niveau du realm ou d'un client ? */
export function estAdminKeycloak(jeton: AuthRequest["user"]): boolean {
  const roles = [...(jeton?.realm_access?.roles ?? []), ...Object.values(jeton?.resource_access ?? {}).flatMap((c) => c.roles ?? [])];
  const admins = rolesAdminKeycloak();
  return roles.some((r) => admins.includes(r.toLowerCase()));
}

/**
 * Associe le compte Keycloak à un utilisateur de l'application.
 * Tout compte du realm entre : créé à sa première connexion, ADMIN s'il a un rôle admin
 * dans Keycloak (ou figure dans ADMIN_EMAILS), COMMERCIAL sinon. Un admin peut ensuite
 * changer son rôle ou le désactiver dans la page Utilisateurs.
 */
export async function utilisateurCourant(req: UtilisateurRequest, res: Response, next: NextFunction) {
  try {
    if (authDesactivee()) {
      // Dev / tests sans Keycloak : admin par défaut, ou un utilisateur précis via X-Dev-Utilisateur
      const email = req.header("X-Dev-Utilisateur")?.toLowerCase();
      if (!email) {
        // Utilisateur réel en base : les actions tracées (corrections, contrats) y font référence
        req.utilisateur = await prisma.user.upsert({
          where: { email: "dev@local" },
          update: {},
          create: { email: "dev@local", nom: "Développeur", prenom: "", role: "ADMIN" },
          select: champs,
        });
        return next();
      }
      const u = await prisma.user.findUnique({ where: { email }, select: champs });
      if (!u?.isActive) return res.status(403).json({ error: "ACCES_NON_ACCORDE" });
      req.utilisateur = u;
      return next();
    }

    const sub = req.user?.sub;
    // Sans le scope "email" sur le client Keycloak, le jeton n'a pas de champ email :
    // on se rabat sur l'identifiant de connexion s'il s'agit d'une adresse e-mail.
    const identifiant = req.user?.preferred_username;
    const email = (req.user?.email ?? (identifiant?.includes("@") ? identifiant : undefined))?.toLowerCase();
    if (!sub) return res.status(401).json({ error: "Token invalide" });

    // Rôle tenu dans Keycloak ; ADMIN_EMAILS ne sert qu'à l'amorçage (premier admin)
    const reglages = await reglagesComptes();
    const roleKc = roleKeycloak(req.user, reglages.roles) ?? (email !== undefined && adminsInitiaux().includes(email) ? "ADMIN" : null);
    let u = await prisma.user.findUnique({ where: { keycloakSub: sub }, select: champs });

    // Première connexion : rattachement par e-mail à un utilisateur ajouté par un admin, sinon création
    if (!u && email) {
      const parEmail = await prisma.user.findUnique({ where: { email }, select: champs });
      if (parEmail && !parEmail.keycloakSub) {
        u = await prisma.user.update({ where: { id: parEmail.id }, data: { keycloakSub: sub }, select: champs });
      } else if (!parEmail) {
        u = await prisma.user.create({
          data: {
            email,
            keycloakSub: sub,
            nom: req.user?.family_name ?? email,
            prenom: req.user?.given_name ?? "",
            role: roleKc ?? "COMMERCIAL",
            roleKeycloak: !!roleKc,
          },
          select: champs,
        });
      }
    }

    // Le rôle suit Keycloak à chaque connexion ; sans rôle de la Régie dans Keycloak, le compte garde le sien.
    // Les rôles du jeton sont retenus : Paramètres les propose pour régler la correspondance.
    const rolesJeton = [...new Set([...(req.user?.realm_access?.roles ?? []), ...Object.values(req.user?.resource_access ?? {}).flatMap((c) => c.roles ?? [])])].sort();
    if (u && (u.roleKeycloak !== !!roleKc || (roleKc && u.role !== roleKc) || u.rolesJeton.join("|") !== rolesJeton.join("|"))) {
      u = await prisma.user.update({ where: { id: u.id }, data: { roleKeycloak: !!roleKc, rolesJeton, ...(roleKc ? { role: roleKc } : {}) }, select: champs });
    }

    // Nom, prénom et téléphone suivent Keycloak à chaque connexion
    const identite = identiteKeycloak(req.user);
    if (u && (Object.keys(identite) as (keyof typeof identite)[]).some((k) => u![k] !== identite[k])) {
      u = await prisma.user.update({ where: { id: u.id }, data: identite, select: champs });
    }

    if (!u || !u.isActive) {
      console.warn(
        `Accès refusé à ${email ?? "(pas d'e-mail dans le jeton)"} : ${u ? "compte désactivé" : "compte sans e-mail, ou e-mail déjà rattaché à un autre compte Keycloak"}`
      );
      return res.status(403).json({
        error: "ACCES_NON_ACCORDE",
        message: "Votre compte n'a pas accès à cette application. Demandez à un administrateur de vous ajouter.",
        email,
      });
    }
    // Photo et identifiant plateforme : toutes les 12 h, ou 10 min tant que l'identifiant manque
    const autorisation = req.header("authorization");
    if (autorisation?.startsWith("Bearer ") && (!u.photoVerifieeLe || Date.now() - u.photoVerifieeLe.getTime() > (u.plateformeUserId ? PHOTO_VALIDE_MS : 10 * 60_000))) {
      u = { ...u, photoVerifieeLe: new Date() };
      releverPhoto(u.id, autorisation, reglages.champsTelephone);
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
