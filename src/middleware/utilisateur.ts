import type { NextFunction, Response } from "express";
import type { User } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import type { AuthRequest } from "./auth.js";
import { peutVoirTout } from "./permissions.js";

export interface UtilisateurRequest extends AuthRequest {
  /**
   * L'utilisateur de la Régie. Les droits viennent du gateway Konitys (requirePerm, userCan) ;
   * `role` n'autorise plus rien (colonne gardée, plus mise à jour). `voitTousLieux` : droit lieux.view_any (mode fermé).
   */
  utilisateur?: Pick<User, "id" | "email" | "nom" | "prenom" | "role" | "lieuId"> & { voitTousLieux: boolean };
}

export const authDesactivee = () => !process.env.KEYCLOAK_URL && process.env.NODE_ENV !== "production";

const champs = { id: true, email: true, nom: true, prenom: true, telephone: true, role: true, lieuId: true, isActive: true, keycloakSub: true, photoVerifieeLe: true, plateformeUserId: true } as const;

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

// Champs possibles du téléphone dans la fiche Hub (le nom exact n'est pas documenté) ; réglable si besoin
const CHAMPS_TELEPHONE = () =>
  (process.env.KONITYS_CHAMPS_TELEPHONE || "telephone,tel,phone,phone_number,mobile,portable,telephone_portable,telephone_mobile")
    .split(/[,;\s]+/)
    .filter(Boolean);

/**
 * Téléphone de la fiche Hub (/api/users/me), pour les alertes SMS : Keycloak et le Hub ont les mêmes utilisateurs,
 * le Hub est la source. Null s'il n'y en a pas (le numéro déjà connu est alors gardé).
 */
export function telephoneHub(reponse: unknown): string | null {
  const r = reponse as { data?: { data?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>;
  const d = (r?.data?.data ?? r?.data ?? r) as Record<string, unknown> | undefined;
  for (const champ of CHAMPS_TELEPHONE()) {
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
function releverPhoto(userId: number, autorisation: string) {
  fetch(`${GATEWAY_KONITYS}/api/users/me`, { headers: { Authorization: autorisation }, signal: AbortSignal.timeout(5000) })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const moi = await r.json();
      const plateformeUserId = idPlateforme(moi);
      const telephone = telephoneHub(moi);
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

/**
 * Associe le compte Keycloak à un utilisateur de l'application (créé à sa première connexion).
 * Ce qu'il peut faire vient des droits Konitys (gateway, /api/permissions/me), pas d'un rôle de la Régie
 * (docs/PERMISSIONS_APP_INTEGRATION.md). Un compte désactivé dans la page Utilisateurs n'entre plus.
 */
export async function utilisateurCourant(req: UtilisateurRequest, res: Response, next: NextFunction) {
  try {
    if (authDesactivee()) {
      // Dev / tests sans Keycloak : admin par défaut, ou un utilisateur précis via X-Dev-Utilisateur
      const email = req.header("X-Dev-Utilisateur")?.toLowerCase();
      if (!email) {
        // Utilisateur réel en base : les actions tracées (corrections, contrats) y font référence
        const dev = await prisma.user.upsert({
          where: { email: "dev@local" },
          update: {},
          create: { email: "dev@local", nom: "Développeur", prenom: "", role: "ADMIN" },
          select: champs,
        });
        req.utilisateur = { ...dev, voitTousLieux: true };
        return next();
      }
      const u = await prisma.user.findUnique({ where: { email }, select: champs });
      if (!u?.isActive) return res.status(403).json({ error: "ACCES_NON_ACCORDE" });
      req.utilisateur = { ...u, voitTousLieux: true };
      return next();
    }

    const sub = req.user?.sub;
    // Sans le scope "email" sur le client Keycloak, le jeton n'a pas de champ email :
    // on se rabat sur l'identifiant de connexion s'il s'agit d'une adresse e-mail.
    const identifiant = req.user?.preferred_username;
    const email = (req.user?.email ?? (identifiant?.includes("@") ? identifiant : undefined))?.toLowerCase();
    if (!sub) return res.status(401).json({ error: "Token invalide" });

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
          },
          select: champs,
        });
      }
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
      releverPhoto(u.id, autorisation);
    }
    // Périmètre des données : décidé une fois par requête, en mode fermé (gateway muet → ses lieux seulement)
    req.utilisateur = { ...u, voitTousLieux: await peutVoirTout(req, "lieux.view_any") };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Périmètre des lieux visibles par l'utilisateur (droits lieux.view_any / lieux.view_own, 3.8) :
 * null = tous ; sinon « les siens » : son lieu s'il en a un (partenaire), sinon ceux dont il est le commercial.
 */
export function perimetreLieux(u: UtilisateurRequest["utilisateur"]): { commercialId?: number; lieuId?: number } | null {
  if (!u) throw new HttpError(401, "NON_AUTHENTIFIE");
  if (u.voitTousLieux) return null;
  return u.lieuId ? { lieuId: u.lieuId } : { commercialId: u.id };
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
