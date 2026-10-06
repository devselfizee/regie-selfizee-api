import { Router } from "express";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";

export const utilisateursRouter = Router();

// GET /api/utilisateurs/moi — l'utilisateur connecté et son rôle (pour adapter le front)
utilisateursRouter.get(
  "/moi",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    res.json(req.utilisateur);
  })
);

const select = {
  id: true, email: true, nom: true, prenom: true, telephone: true, role: true, isActive: true,
  lieuId: true, keycloakSub: true, createdAt: true,
  lieu: { select: { id: true, enseigne: true } },
  _count: { select: { lieuxCommercial: true } },
} as const;

// GET /api/utilisateurs
utilisateursRouter.get(
  "/",
  exiger("ADMIN"),
  asynchrone(async (_req, res) => {
    const users = await prisma.user.findMany({ orderBy: [{ isActive: "desc" }, { nom: "asc" }], select });
    res.json(
      users.map(({ keycloakSub, _count, ...u }) => ({ ...u, dejaConnecte: Boolean(keycloakSub), nbLieux: _count.lieuxCommercial }))
    );
  })
);

const base = {
  nom: z.string().trim().min(1),
  prenom: z.string().trim(),
  telephone: z.string().trim().nullable().optional(),
  role: z.enum(UserRole),
  lieuId: z.number().int().positive().nullable().optional(),
};
const partenaireAvecLieu = (u: { role?: UserRole; lieuId?: number | null }) => u.role !== "PARTENAIRE" || Boolean(u.lieuId);
const MSG_PARTENAIRE = { message: "Un partenaire doit être rattaché à un lieu", path: ["lieuId"] };

// POST /api/utilisateurs — ajouter une personne (elle se connecte ensuite avec son compte Keycloak, même e-mail)
utilisateursRouter.post(
  "/",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const data = z
      .object({ email: z.email().transform((e) => e.toLowerCase()), ...base })
      .refine(partenaireAvecLieu, MSG_PARTENAIRE)
      .parse(req.body);
    const u = await prisma.user.create({
      data: { ...data, lieuId: data.role === "PARTENAIRE" ? data.lieuId : null },
      select,
    });
    res.status(201).json(u);
  })
);

// PATCH /api/utilisateurs/:id — changer le rôle, désactiver…
utilisateursRouter.patch(
  "/:id",
  exiger("ADMIN"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = Number(req.params.id);
    const patch = z
      .object({ ...base, nom: base.nom.optional(), prenom: base.prenom.optional(), role: base.role.optional(), isActive: z.boolean().optional() })
      .parse(req.body);

    const avant = await prisma.user.findUniqueOrThrow({ where: { id } });
    const role = patch.role ?? avant.role;
    const lieuId = patch.lieuId === undefined ? avant.lieuId : patch.lieuId;
    if (!partenaireAvecLieu({ role, lieuId })) throw new HttpError(400, "VALIDATION", MSG_PARTENAIRE.message);

    // Éviter de se retirer soi-même l'accès admin
    if (id === req.utilisateur?.id && (role !== "ADMIN" || patch.isActive === false)) {
      throw new HttpError(400, "AUTO_RETRAIT", "Vous ne pouvez pas retirer votre propre accès administrateur");
    }

    const u = await prisma.user.update({
      where: { id },
      data: { ...patch, lieuId: role === "PARTENAIRE" ? lieuId : null },
      select,
    });
    res.json(u);
  })
);
