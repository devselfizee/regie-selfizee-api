import { Router } from "express";
import type { ImportErreurStatut } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const importsRouter = Router();

// GET /api/imports/erreurs?statut=NOUVELLE&page=1 — file d'erreurs consultable (CDC §4.5)
importsRouter.get("/erreurs", async (req, res, next) => {
  try {
    const statut = (req.query.statut as ImportErreurStatut | undefined) ?? "NOUVELLE";
    const page = Math.max(1, Number(req.query.page) || 1);
    const parPage = 50;

    const where = { statut };
    const [total, erreurs] = await Promise.all([
      prisma.importErreur.count({ where }),
      prisma.importErreur.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * parPage,
        take: parPage,
        include: {
          import: { select: { id: true, borneIdentifiant: true, recuLe: true, type: true, ipSource: true } },
        },
      }),
    ]);

    res.json({ total, page, parPage, erreurs });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/imports/erreurs/:id { statut: "RETRAITEE" | "IGNOREE" }
importsRouter.patch("/erreurs/:id", async (req, res, next) => {
  try {
    const statut = req.body?.statut as ImportErreurStatut;
    if (!["RETRAITEE", "IGNOREE", "NOUVELLE"].includes(statut)) {
      return res.status(400).json({ error: "statut invalide" });
    }
    const erreur = await prisma.importErreur.update({
      where: { id: BigInt(req.params.id) },
      data: { statut, traiteLe: statut === "NOUVELLE" ? null : new Date() },
    });
    res.json(erreur);
  } catch (err) {
    next(err);
  }
});

// GET /api/imports/non-affectees — transactions reçues de bornes sans lieu à leur date
importsRouter.get("/non-affectees", async (_req, res, next) => {
  try {
    const parBorne = await prisma.transaction.groupBy({
      by: ["borneId"],
      where: { lieuId: null },
      _count: true,
      _min: { horodatage: true },
      _max: { horodatage: true },
    });
    res.json(parBorne);
  } catch (err) {
    next(err);
  }
});
