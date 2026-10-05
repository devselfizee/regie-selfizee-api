import { Router } from "express";
import { BorneStatut } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { genererCle } from "../lib/cleBorne.js";
import { reattribuerTransactions } from "../ingestion/reattribution.js";

export const bornesRouter = Router();
export const affectationsRouter = Router();

// Une borne est "en ligne" si son dernier heartbeat a moins de 15 min
const EN_LIGNE_MS = 15 * 60_000;

const sansCle = <T extends { apiKeyHash?: string | null }>({ apiKeyHash, ...b }: T) => ({
  ...b,
  cleConfiguree: Boolean(apiKeyHash),
});

// GET /api/bornes?gammeId=&statut=&q=
bornesRouter.get(
  "/",
  asynchrone(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const bornes = await prisma.borne.findMany({
      where: {
        ...(req.query.gammeId ? { gammeId: Number(req.query.gammeId) } : {}),
        ...(req.query.statut ? { statut: req.query.statut as BorneStatut } : {}),
        ...(q
          ? { OR: [{ identifiant: { contains: q, mode: "insensitive" } }, { numeroSerie: { contains: q, mode: "insensitive" } }] }
          : {}),
      },
      orderBy: { identifiant: "asc" },
      include: {
        gamme: true,
        modules: { where: { retireLe: null }, include: { type: true } },
        affectations: { where: { fin: null }, include: { lieu: { select: { id: true, enseigne: true, ville: true } } } },
      },
    });
    const maintenant = Date.now();
    res.json(
      bornes.map(({ affectations, ...b }) => ({
        ...sansCle(b),
        lieuActuel: affectations[0]?.lieu ?? null,
        affectationActuelle: affectations[0] ? { id: affectations[0].id, debut: affectations[0].debut } : null,
        enLigne: b.dernierHeartbeat ? maintenant - b.dernierHeartbeat.getTime() < EN_LIGNE_MS : false,
      }))
    );
  })
);

// GET /api/bornes/:id — avec historique d'affectations
bornesRouter.get(
  "/:id",
  asynchrone(async (req, res) => {
    const borne = await prisma.borne.findUniqueOrThrow({
      where: { id: Number(req.params.id) },
      include: {
        gamme: true,
        modules: { include: { type: true }, orderBy: { id: "desc" } },
        affectations: { orderBy: { debut: "desc" }, include: { lieu: { select: { id: true, enseigne: true, ville: true } } } },
        heartbeats: { orderBy: { horodatage: "desc" }, take: 1 },
      },
    });
    const nonAffectees = await prisma.transaction.count({ where: { borneId: borne.id, lieuId: null } });
    res.json({ ...sansCle(borne), nonAffectees });
  })
);

const borneSchema = z.object({
  identifiant: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{2,63}$/, "Identifiant : majuscules, chiffres, - et _"),
  gammeId: z.number().int().positive(),
  numeroSerie: z.string().trim().min(1),
  statut: z.enum(BorneStatut).optional(),
  crmId: z.number().int().nullable().optional(),
  coutAchatCents: z.number().int().min(0).nullable().optional(),
  dureeAmortissementMois: z.number().int().min(0).nullable().optional(),
  dateMiseEnService: z.iso.date().nullable().optional().transform((v) => (v ? new Date(`${v}T00:00:00Z`) : v)),
  // Module de paiement principal (créé ou rattaché)
  module: z
    .object({ typeId: z.number().int().positive(), numeroSerie: z.string().trim().min(1).optional() })
    .optional(),
});

// POST /api/bornes — crée la borne et renvoie sa clé API (affichée une seule fois)
bornesRouter.post(
  "/",
  asynchrone(async (req, res) => {
    const { module, ...data } = borneSchema.parse(req.body);
    const cle = genererCle();
    const borne = await prisma.borne.create({
      data: {
        ...data,
        apiKeyHash: cle.hash,
        apiKeyPrefix: cle.prefixe,
        apiKeyCreeLe: new Date(),
        modules: module ? { create: { typeId: module.typeId, numeroSerie: module.numeroSerie } } : undefined,
      },
    });
    res.status(201).json({ ...sansCle(borne), cleApi: cle.cle });
  })
);

// PUT /api/bornes/:id
bornesRouter.put(
  "/:id",
  asynchrone(async (req, res) => {
    const { module, ...data } = borneSchema.parse(req.body);
    const borneId = Number(req.params.id);
    const borne = await prisma.$transaction(async (db) => {
      if (module) {
        const actuel = await db.modulePaiement.findFirst({ where: { borneId, retireLe: null } });
        const identique = actuel?.typeId === module.typeId && (actuel?.numeroSerie ?? undefined) === module.numeroSerie;
        if (!identique) {
          if (actuel) await db.modulePaiement.update({ where: { id: actuel.id }, data: { retireLe: new Date() } });
          await db.modulePaiement.create({
            data: { borneId, typeId: module.typeId, numeroSerie: module.numeroSerie, installeLe: new Date() },
          });
        }
      }
      return db.borne.update({ where: { id: borneId }, data });
    });
    res.json(sansCle(borne));
  })
);

// POST /api/bornes/:id/cle — régénère la clé (l'ancienne cesse de fonctionner)
bornesRouter.post(
  "/:id/cle",
  asynchrone(async (req, res) => {
    const cle = genererCle();
    const borne = await prisma.borne.update({
      where: { id: Number(req.params.id) },
      data: { apiKeyHash: cle.hash, apiKeyPrefix: cle.prefixe, apiKeyCreeLe: new Date() },
    });
    res.json({ identifiant: borne.identifiant, cleApi: cle.cle });
  })
);

// ─── Affectations ───────────────────────────────────────────

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

// POST /api/affectations — affecte une borne à un lieu à partir de `debut`.
// Si la borne a une affectation ouverte commencée avant, elle est clôturée à `debut`.
affectationsRouter.post(
  "/",
  asynchrone(async (req, res) => {
    const { borneId, lieuId, debut, fin, emplacementNotes } = z
      .object({
        borneId: z.number().int().positive(),
        lieuId: z.number().int().positive(),
        debut: instant,
        fin: instant.nullable().optional(),
        emplacementNotes: z.string().trim().nullable().optional(),
      })
      .refine((a) => !a.fin || a.fin > a.debut, "fin doit être après début")
      .parse(req.body);

    const affectation = await prisma.$transaction(async (db) => {
      const ouverte = await db.affectationBorne.findFirst({ where: { borneId, fin: null } });
      if (ouverte && ouverte.debut < debut) {
        await db.affectationBorne.update({ where: { id: ouverte.id }, data: { fin: debut } });
      }
      return db.affectationBorne.create({ data: { borneId, lieuId, debut, fin, emplacementNotes } });
    });

    await prisma.borne.updateMany({ where: { id: borneId, statut: "EN_STOCK" }, data: { statut: "INSTALLEE" } });
    await reattribuerTransactions(borneId, debut, fin ?? null);
    res.status(201).json(affectation);
  })
);

// PATCH /api/affectations/:id — corriger les dates (ex. retrait de la borne : fin = maintenant)
affectationsRouter.patch(
  "/:id",
  asynchrone(async (req, res) => {
    const patch = z
      .object({ debut: instant.optional(), fin: instant.nullable().optional(), emplacementNotes: z.string().nullable().optional() })
      .parse(req.body);
    const avant = await prisma.affectationBorne.findUniqueOrThrow({ where: { id: Number(req.params.id) } });
    const debut = patch.debut ?? avant.debut;
    const fin = patch.fin === undefined ? avant.fin : patch.fin;
    if (fin && fin <= debut) throw new HttpError(400, "DATES_INVALIDES", "fin doit être après début");

    const apres = await prisma.affectationBorne.update({ where: { id: avant.id }, data: { ...patch } });

    // Plage couvrant l'ancienne et la nouvelle période
    const plageDebut = debut < avant.debut ? debut : avant.debut;
    const plageFin = !fin || !avant.fin ? null : fin > avant.fin ? fin : avant.fin;
    await reattribuerTransactions(avant.borneId, plageDebut, plageFin);
    res.json(apres);
  })
);

// DELETE /api/affectations/:id — affectation saisie par erreur
affectationsRouter.delete(
  "/:id",
  asynchrone(async (req, res) => {
    const id = Number(req.params.id);
    const [, a] = await prisma.$transaction([
      prisma.transaction.updateMany({ where: { affectationId: id }, data: { affectationId: null, lieuId: null } }),
      prisma.affectationBorne.delete({ where: { id } }),
    ]);
    await reattribuerTransactions(a.borneId, a.debut, a.fin);
    res.status(204).end();
  })
);
