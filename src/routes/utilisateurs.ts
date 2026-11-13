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
    // superAdmin : e-mail dans ADMIN_EMAILS, seul à pouvoir supprimer un lieu ou une borne
    res.json({ ...req.utilisateur, superAdmin: estSuperAdmin(req.utilisateur?.email) });
  })
);

const select = {
  id: true, email: true, nom: true, prenom: true, telephone: true, alertesSms: true, alertesEmail: true, isActive: true,
  lieuId: true, keycloakSub: true, createdAt: true, profilsHub: true, adminPlateforme: true, profilsRelevesLe: true,
  lieu: { select: { id: true, enseigne: true } },
  _count: { select: { lieuxCommercial: true } },
} as const;

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
      users.map(({ keycloakSub, _count, profilsHub, ...u }) => ({
        ...u,
        dejaConnecte: Boolean(keycloakSub),
        nbLieux: _count.lieuxCommercial,
        // Profils de l'Admin Panel, par leur nom quand la liste est lisible, sinon par leur numéro
        profils: profilsHub.map((id) => libelles[id] ?? `Profil n° ${id}`),
      }))
    );
  })
);

// Identité depuis Keycloak, droits depuis l'Admin Panel Konitys : la Régie ne gère ici que l'accès
// (ajout, désactivation), le lieu d'un partenaire et les SMS des alertes.
const base = { lieuId: z.number().int().positive().nullable().optional() };

// POST /api/utilisateurs — ajouter une personne (elle se connecte ensuite avec son compte Keycloak, même e-mail)
utilisateursRouter.post(
  "/",
  requirePerm("utilisateurs.manage"),
  asynchrone(async (req, res) => {
    const data = z.object({ email: z.email().transform((e) => e.toLowerCase()), ...base }).parse(req.body);
    const u = await prisma.user.create({
      // L'e-mail tient lieu de nom jusqu'à la première connexion, qui reprend celui de Keycloak
      data: { email: data.email, nom: data.email, prenom: "", lieuId: data.lieuId ?? null },
      select,
    });
    res.status(201).json(u);
  })
);

// PATCH /api/utilisateurs/:id — lieu du partenaire, SMS des alertes, désactivation (jamais l'identité ni les droits)
utilisateursRouter.patch(
  "/:id",
  requirePerm("utilisateurs.manage"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = Number(req.params.id);
    const patch = z.object({ ...base, isActive: z.boolean().optional(), alertesSms: z.boolean().optional(), alertesEmail: z.boolean().optional() }).parse(req.body);
    const avant = await prisma.user.findUniqueOrThrow({ where: { id } });
    const lieuId = patch.lieuId === undefined ? avant.lieuId : patch.lieuId;

    // Éviter de se couper soi-même l'accès
    if (id === req.utilisateur?.id && patch.isActive === false) {
      throw new HttpError(400, "AUTO_RETRAIT", "Vous ne pouvez pas désactiver votre propre compte");
    }

    const u = await prisma.user.update({
      where: { id },
      data: { ...patch, lieuId },
      select,
    });
    res.json(u);
  })
);
