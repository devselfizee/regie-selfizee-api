import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { effacerDemo, etatDemo, genererDemo } from "../demo/demo.js";

// Données de démonstration (admin) : pour montrer l'application avant les vraies bornes
export const demoRouter = Router();

const journaliser = (req: UtilisateurRequest, action: string, apres: object) =>
  prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "demo", entiteId: "-", action, apres } });

// GET /api/demo — présence et volume des données de démonstration
demoRouter.get("/", asynchrone(async (_req, res) => res.json(await etatDemo())));

// POST /api/demo — génère les données (409 si elles existent déjà)
demoRouter.post(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const r = await genererDemo();
    await journaliser(req, "DEMO_GENEREE", r);
    res.status(201).json(r);
  })
);

// DELETE /api/demo — efface tout ce qui dépend des lieux et bornes de démonstration
demoRouter.delete(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const r = await effacerDemo();
    await journaliser(req, "DEMO_EFFACEE", r);
    res.json(r);
  })
);
