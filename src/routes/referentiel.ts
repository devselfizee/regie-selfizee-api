import { Router } from "express";
import { RefCategorie } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import { exiger } from "../middleware/utilisateur.js";

export const referentielRouter = Router();

// GET /api/referentiel — toutes les listes nécessaires aux formulaires et filtres
referentielRouter.get(
  "/",
  asynchrone(async (_req, res) => {
    const [valeurs, gammes, typesModule, commerciaux] = await Promise.all([
      prisma.refValeur.findMany({ orderBy: [{ categorie: "asc" }, { ordre: "asc" }, { libelle: "asc" }] }),
      prisma.gamme.findMany({ orderBy: { libelle: "asc" } }),
      prisma.typeModulePaiement.findMany({ orderBy: { libelle: "asc" } }),
      prisma.user.findMany({
        where: { isActive: true, role: { in: ["COMMERCIAL", "ADMIN"] } },
        select: { id: true, nom: true, prenom: true },
        orderBy: { nom: "asc" },
      }),
    ]);

    const listes = Object.fromEntries(Object.values(RefCategorie).map((c) => [c, [] as typeof valeurs]));
    for (const v of valeurs) listes[v.categorie].push(v);

    res.json({ listes, gammes, typesModule, commerciaux });
  })
);

const codeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,64}$/, "Code : lettres, chiffres, _");

// POST /api/referentiel/valeurs — ajouter une valeur à une liste administrable
referentielRouter.post(
  "/valeurs",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const data = z
      .object({
        categorie: z.enum(RefCategorie),
        code: codeSchema,
        libelle: z.string().trim().min(1),
        parentId: z.number().int().optional(),
        ordre: z.number().int().optional(),
      })
      .parse(req.body);
    res.status(201).json(await prisma.refValeur.create({ data }));
  })
);

// PATCH /api/referentiel/valeurs/:id — renommer, réordonner, désactiver (jamais supprimer : historique)
referentielRouter.patch(
  "/valeurs/:id",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const data = z
      .object({
        libelle: z.string().trim().min(1).optional(),
        ordre: z.number().int().optional(),
        actif: z.boolean().optional(),
        parentId: z.number().int().nullable().optional(),
      })
      .parse(req.body);
    res.json(await prisma.refValeur.update({ where: { id: Number(req.params.id) }, data }));
  })
);

// POST /api/referentiel/gammes et /types-module — nouvelles gammes / modules sans développement
referentielRouter.post(
  "/gammes",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const data = z.object({ code: codeSchema, libelle: z.string().trim().min(1) }).parse(req.body);
    res.status(201).json(await prisma.gamme.create({ data }));
  })
);

referentielRouter.post(
  "/types-module",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const data = z
      .object({
        code: codeSchema,
        libelle: z.string().trim().min(1),
        fournisseur: z.string().trim().optional(),
        rapprochable: z.boolean().optional(),
      })
      .parse(req.body);
    res.status(201).json(await prisma.typeModulePaiement.create({ data }));
  })
);

const patchSimple = z.object({ libelle: z.string().trim().min(1).optional(), actif: z.boolean().optional() });

// PATCH /api/referentiel/gammes/:id et /types-module/:id — renommer, désactiver
referentielRouter.patch(
  "/gammes/:id",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    res.json(await prisma.gamme.update({ where: { id: Number(req.params.id) }, data: patchSimple.parse(req.body) }));
  })
);

referentielRouter.patch(
  "/types-module/:id",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    res.json(await prisma.typeModulePaiement.update({ where: { id: Number(req.params.id) }, data: patchSimple.parse(req.body) }));
  })
);
