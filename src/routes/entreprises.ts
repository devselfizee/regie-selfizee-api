import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { libellesProfils, requirePerm } from "../middleware/permissions.js";
import { comptesRegieConfigures } from "../lib/keycloakRegie.js";
import { creerCompteClient, lieuxEntreprise, listerComptes, modifierCompteClient, profilsProposes, renvoyerInvitation } from "../comptes/comptesRegie.js";

// Entreprises clientes et leurs comptes (option 2 du 20/11/2026) : monté sous /api/entreprises, droit entreprises.manage.
// Une entreprise possède des lieux ; ses comptes se connectent par le realm « regie » et voient tout ou partie de ces lieux.
export const entreprisesRouter = Router();
entreprisesRouter.use(requirePerm("entreprises.manage"));

const id = (v: unknown) => z.coerce.number().int().positive().max(2_147_483_647).parse(v);

// GET /api/entreprises
entreprisesRouter.get(
  "/",
  asynchrone(async (_req, res) => {
    const liste = await prisma.entreprise.findMany({
      orderBy: [{ actif: "desc" }, { nom: "asc" }],
      select: {
        id: true, nom: true, actif: true, createdAt: true,
        _count: { select: { lieux: { where: { supprimeLe: null } }, comptes: { where: { compte: "REGIE", isActive: true } } } },
      },
    });
    res.json({
      configure: comptesRegieConfigures(),
      entreprises: liste.map(({ _count, ...e }) => ({ ...e, nbLieux: _count.lieux, nbComptes: _count.comptes })),
    });
  })
);

const corpsEntreprise = z.object({ nom: z.string().trim().min(1).max(200), notes: z.string().max(2000).nullable().optional() });

// POST /api/entreprises
entreprisesRouter.post(
  "/",
  asynchrone(async (req, res) => {
    const d = corpsEntreprise.parse(req.body);
    const e = await prisma.entreprise.create({ data: d, select: { id: true } });
    res.status(201).json(e);
  })
);

// GET /api/entreprises/:id — l'entreprise, ses lieux, ses comptes et les profils qu'on peut leur attribuer
entreprisesRouter.get(
  "/:id",
  asynchrone(async (req, res) => {
    const entrepriseId = id(req.params.id);
    const e = await prisma.entreprise.findUnique({ where: { id: entrepriseId }, select: { id: true, nom: true, actif: true, notes: true, createdAt: true } });
    if (!e) throw new HttpError(404, "INTROUVABLE");
    const [lieux, comptes, profils] = await Promise.all([lieuxEntreprise(entrepriseId), listerComptes(entrepriseId), profilsProposes(await libellesProfils(req))]);
    res.json({ ...e, lieux, comptes, profils, configure: comptesRegieConfigures() });
  })
);

// PATCH /api/entreprises/:id — nom, notes, activation (désactivée : plus aucun de ses comptes n'entre)
entreprisesRouter.patch(
  "/:id",
  asynchrone(async (req, res) => {
    const d = corpsEntreprise.partial().extend({ actif: z.boolean().optional() }).parse(req.body);
    await prisma.entreprise.update({ where: { id: id(req.params.id) }, data: d });
    res.json({ ok: true });
  })
);

// PUT /api/entreprises/:id/lieux — les lieux de l'entreprise (la liste envoyée remplace l'ancienne)
entreprisesRouter.put(
  "/:id/lieux",
  asynchrone(async (req, res) => {
    const entrepriseId = id(req.params.id);
    const { lieuIds } = z.object({ lieuIds: z.array(z.number().int().positive()).max(1000) }).parse(req.body);
    const ids = [...new Set(lieuIds)];
    await prisma.entreprise.findUniqueOrThrow({ where: { id: entrepriseId }, select: { id: true } });
    const lieux = await prisma.lieu.findMany({ where: { id: { in: ids }, supprimeLe: null }, select: { id: true, enseigne: true, entrepriseId: true } });
    if (lieux.length !== ids.length) throw new HttpError(400, "LIEU_INCONNU", "Un des lieux n'existe pas.");
    // Un lieu n'appartient qu'à une entreprise : le retirer d'abord de l'autre, en connaissance de cause
    const ailleurs = lieux.find((l) => l.entrepriseId && l.entrepriseId !== entrepriseId);
    if (ailleurs) throw new HttpError(409, "LIEU_AUTRE_ENTREPRISE", `${ailleurs.enseigne} appartient déjà à une autre entreprise.`);
    await prisma.$transaction([
      prisma.lieu.updateMany({ where: { entrepriseId, id: { notIn: ids } }, data: { entrepriseId: null } }),
      prisma.lieu.updateMany({ where: { id: { in: ids } }, data: { entrepriseId } }),
    ]);
    res.json({ ok: true });
  })
);

export const corpsNouveauCompte = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  prenom: z.string().trim().min(1).max(100),
  nom: z.string().trim().min(1).max(100),
  profilId: z.number().int().positive(),
  lieuIds: z.array(z.number().int().positive()).max(1000).default([]),
});
export const corpsModifCompte = z.object({
  profilId: z.number().int().positive().optional(),
  lieuIds: z.array(z.number().int().positive()).max(1000).optional(),
  isActive: z.boolean().optional(),
});

// POST /api/entreprises/:id/comptes — crée le compte (Régie + Keycloak) et envoie l'invitation
entreprisesRouter.post(
  "/:id/comptes",
  asynchrone(async (req, res) => {
    const compteId = await creerCompteClient(id(req.params.id), corpsNouveauCompte.parse(req.body));
    res.status(201).json({ id: compteId });
  })
);

// PATCH /api/entreprises/:id/comptes/:compteId — profil, lieux, activation
entreprisesRouter.patch(
  "/:id/comptes/:compteId",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    await modifierCompteClient(id(req.params.id), id(req.params.compteId), corpsModifCompte.parse(req.body));
    res.json({ ok: true });
  })
);

// POST /api/entreprises/:id/comptes/:compteId/invitation — renvoyer l'e-mail d'invitation
entreprisesRouter.post(
  "/:id/comptes/:compteId/invitation",
  asynchrone(async (req, res) => {
    await renvoyerInvitation(id(req.params.id), id(req.params.compteId));
    res.json({ ok: true });
  })
);
