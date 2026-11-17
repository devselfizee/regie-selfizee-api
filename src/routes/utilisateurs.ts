import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { requirePerm, libellesProfils } from "../middleware/permissions.js";
import { estSuperAdmin } from "../lib/superAdmin.js";

export const utilisateursRouter = Router();

// GET /api/utilisateurs/moi — l'utilisateur connecté (ses droits, eux, viennent du gateway Konitys)
utilisateursRouter.get(
  "/moi",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const u = req.utilisateur!;
    // Ses lieux (client) avec leur nom : le menu « Mon lieu » / « Mes lieux » sans le droit de voir la liste
    const lieux = u.lieuIds.length
      ? await prisma.lieu.findMany({ where: { id: { in: u.lieuIds }, supprimeLe: null }, select: { id: true, enseigne: true }, orderBy: { enseigne: "asc" } })
      : [];
    // superAdmin : e-mail dans ADMIN_EMAILS, seul à pouvoir supprimer un lieu ou une borne
    res.json({ ...u, lieux, superAdmin: estSuperAdmin(u.email) });
  })
);

const select = {
  id: true, email: true, nom: true, prenom: true, telephone: true, alertesSms: true, alertesEmail: true, isActive: true,
  keycloakSub: true, createdAt: true, profilsHub: true, adminPlateforme: true, profilsRelevesLe: true,
  // Lieux auxquels un client a accès (demande du 17/11 : un ou plusieurs lieux)
  accesLieux: { select: { lieu: { select: { id: true, enseigne: true } } }, orderBy: { lieu: { enseigne: "asc" } } },
  _count: { select: { lieuxCommercial: true, apports: true } },
} as const;

/** Réponse de la page Utilisateurs : les lieux à plat, et si la personne est apporteur d'affaires */
const presenter = <U extends { accesLieux: { lieu: { id: number; enseigne: string } }[]; _count: { lieuxCommercial: number; apports: number } }>(u: U) => {
  const { accesLieux, _count, ...reste } = u;
  return { ...reste, lieux: accesLieux.map((a) => a.lieu), lieuIds: accesLieux.map((a) => a.lieu.id), nbLieux: _count.lieuxCommercial, apporteur: _count.apports > 0 };
};

// GET /api/utilisateurs
utilisateursRouter.get(
  "/",
  requirePerm("utilisateurs.manage"),
  asynchrone(async (req, res) => {
    const [users, libelles] = await Promise.all([
      prisma.user.findMany({ orderBy: [{ isActive: "desc" }, { nom: "asc" }], select }),
      libellesProfils(req),
    ]);
    res.json(
      users.map(presenter).map(({ keycloakSub, profilsHub, ...u }) => ({
        ...u,
        dejaConnecte: Boolean(keycloakSub),
        // Profils de l'Admin Panel, par leur nom quand la liste est lisible, sinon par leur numéro
        profils: profilsHub.map((id) => libelles[id] ?? `Profil n° ${id}`),
      }))
    );
  })
);

// Identité depuis Keycloak, droits depuis l'Admin Panel Konitys : la Régie ne gère ici que l'accès
// (ajout, désactivation), les lieux d'un client et les SMS des alertes.
const base = { lieuIds: z.array(z.number().int().positive()).max(500).optional() };

/** Les lieux demandés existent (et ne sont pas supprimés), sans doublon */
async function lieuxValides(lieuIds: number[]): Promise<number[]> {
  const ids = [...new Set(lieuIds)];
  if (!ids.length) return [];
  const existants = await prisma.lieu.findMany({ where: { id: { in: ids }, supprimeLe: null }, select: { id: true } });
  if (existants.length !== ids.length) throw new HttpError(400, "LIEU_INCONNU", "Un des lieux n'existe pas");
  return ids;
}

// POST /api/utilisateurs — ajouter une personne (elle se connecte ensuite avec son compte Keycloak, même e-mail)
utilisateursRouter.post(
  "/",
  requirePerm("utilisateurs.manage"),
  asynchrone(async (req, res) => {
    const data = z.object({ email: z.email().transform((e) => e.toLowerCase()), ...base }).parse(req.body);
    const lieuIds = await lieuxValides(data.lieuIds ?? []);
    const u = await prisma.user.create({
      // L'e-mail tient lieu de nom jusqu'à la première connexion, qui reprend celui de Keycloak
      data: { email: data.email, nom: data.email, prenom: "", accesLieux: { create: lieuIds.map((lieuId) => ({ lieuId })) } },
      select,
    });
    res.status(201).json(presenter(u));
  })
);

// PATCH /api/utilisateurs/:id — lieux du client, SMS des alertes, désactivation (jamais l'identité ni les droits)
utilisateursRouter.patch(
  "/:id",
  requirePerm("utilisateurs.manage"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = Number(req.params.id);
    const { lieuIds, ...patch } = z.object({ ...base, isActive: z.boolean().optional(), alertesSms: z.boolean().optional(), alertesEmail: z.boolean().optional() }).parse(req.body);
    await prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true } });

    // Éviter de se couper soi-même l'accès
    if (id === req.utilisateur?.id && patch.isActive === false) {
      throw new HttpError(400, "AUTO_RETRAIT", "Vous ne pouvez pas désactiver votre propre compte");
    }

    // Lieux : la liste envoyée remplace l'ancienne
    const acces = lieuIds === undefined ? undefined : await lieuxValides(lieuIds);
    const u = await prisma.user.update({
      where: { id },
      data: { ...patch, ...(acces ? { accesLieux: { deleteMany: {}, create: acces.map((lieuId) => ({ lieuId })) } } : {}) },
      select,
    });
    res.json(presenter(u));
  })
);
