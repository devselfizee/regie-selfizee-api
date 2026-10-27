import { Router } from "express";
import type { ImportErreurStatut, ImportStatut, ImportType, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ingererLotTransactions } from "../ingestion/transactions.js";
import { erreursParLigne, erreursUniquementSurLignes, formaterErreurs, validerLotParcours, validerLotTransactions, type LotParcoursJson, type LotTransactionsJson } from "../ingestion/validation.js";
import { ingererLotParcours } from "../ingestion/parcours.js";

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

// ─── Journal des envois des bornes ──────────────────────────
// Tout ce que les bornes ont envoyé, accepté ou refusé, pour vérifier qu'une borne transmet bien.

const parPageJournal = 50;
const filtreBorne = (q: unknown) => (typeof q === "string" && q.trim() ? q.trim() : undefined);

// GET /api/imports/journal?borne=S221&type=TRANSACTIONS&statut=REJETE&page=1 — lots reçus, sans leur contenu
importsRouter.get("/journal", async (req, res, next) => {
  try {
    const borne = filtreBorne(req.query.borne);
    const type = ["TRANSACTIONS", "HEARTBEAT", "RELEVE_MONETIQUE", "PARCOURS"].includes(String(req.query.type)) ? (String(req.query.type) as ImportType) : undefined;
    const statut = ["OK", "PARTIEL", "REJETE"].includes(String(req.query.statut)) ? (String(req.query.statut) as ImportStatut) : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const where: Prisma.ImportLotWhereInput = {
      // Identifiant envoyé par la borne : présent même si la borne est inconnue ou la clé refusée
      ...(borne ? { OR: [{ borneIdentifiant: { contains: borne, mode: "insensitive" } }, { borne: { identifiant: { contains: borne, mode: "insensitive" } } }] } : {}),
      ...(type ? { type } : {}),
      ...(statut ? { statut } : {}),
    };
    const [total, lots] = await Promise.all([
      prisma.importLot.count({ where }),
      prisma.importLot.findMany({
        where,
        orderBy: { recuLe: "desc" },
        skip: (page - 1) * parPageJournal,
        take: parPageJournal,
        select: {
          id: true, source: true, type: true, borneIdentifiant: true, schemaVersion: true, recuLe: true, ipSource: true, statut: true,
          nbRecues: true, nbCreees: true, nbDoublons: true, nbRejetees: true,
          borne: { select: { id: true, identifiant: true } },
          erreurs: { select: { code: true }, take: 3 },
        },
      }),
    ]);
    res.json({ total, page, parPage: parPageJournal, lots });
  } catch (err) {
    next(err);
  }
});

// GET /api/imports/journal/:id — un lot : contenu brut reçu et erreurs
importsRouter.get("/journal/:id", async (req, res, next) => {
  try {
    const lot = await prisma.importLot.findUniqueOrThrow({
      where: { id: BigInt(req.params.id) },
      include: {
        borne: { select: { id: true, identifiant: true } },
        erreurs: { orderBy: { index: "asc" }, select: { index: true, transactionIdModule: true, code: true, message: true } },
      },
    });
    res.json(lot);
  } catch (err) {
    next(err);
  }
});

// GET /api/imports/signes-de-vie?borne=S221 — derniers signes de vie acceptés (les refusés sont dans le journal)
importsRouter.get("/signes-de-vie", async (req, res, next) => {
  try {
    const borne = filtreBorne(req.query.borne);
    const signes = await prisma.heartbeat.findMany({
      where: borne ? { borne: { identifiant: { contains: borne, mode: "insensitive" } } } : {},
      orderBy: { recuLe: "desc" },
      take: 200,
      include: { borne: { select: { id: true, identifiant: true } } },
    });
    res.json(signes);
  } catch (err) {
    next(err);
  }
});

// POST /api/imports/journal/:id/rejouer — rejoue un lot de ventes déjà reçu (après correction du référentiel,
// par exemple un module réactivé). Sans risque : les ventes déjà intégrées sont reconnues comme doublons.
importsRouter.post("/journal/:id/rejouer", async (req, res, next) => {
  try {
    const lot = await prisma.importLot.findUniqueOrThrow({ where: { id: BigInt(req.params.id) }, include: { borne: true } });
    if (!["TRANSACTIONS", "PARCOURS"].includes(lot.type) || !lot.borne) {
      return res.status(400).json({ error: "NON_REJOUABLE", message: "Seul un lot de ventes ou de parcours d'une borne connue peut être rejoué" });
    }
    if (lot.type === "PARCOURS") {
      if (!validerLotParcours(lot.payload) && !erreursUniquementSurLignes(validerLotParcours.errors ?? [], "parcours")) {
        return res.status(400).json({ error: "SCHEMA_INVALIDE", message: formaterErreurs(validerLotParcours.errors) });
      }
      const invalides = validerLotParcours(lot.payload) ? new Map<number, string>() : erreursParLigne(validerLotParcours.errors ?? [], "parcours");
      return res.json(await ingererLotParcours(lot.borne, lot.payload as unknown as LotParcoursJson, req.ip, "RATTRAPAGE_MANUEL", invalides));
    }
    if (!validerLotTransactions(lot.payload) && !erreursUniquementSurLignes(validerLotTransactions.errors ?? [])) {
      return res.status(400).json({ error: "SCHEMA_INVALIDE", message: formaterErreurs(validerLotTransactions.errors) });
    }
    const resultat = await ingererLotTransactions(lot.borne, lot.payload as unknown as LotTransactionsJson, req.ip, "RATTRAPAGE_MANUEL");
    res.json(resultat);
  } catch (err) {
    next(err);
  }
});
