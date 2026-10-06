import { Router } from "express";
import { CategorieCout } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { lireFiltres, ymd } from "../stats/filtres.js";
import { rentabiliteBorne, retourInvestissement } from "../rentabilite/calcul.js";

// Coûts, interventions SAV et rentabilité des bornes (CDC §5.3 et §8)
export const coutsBornesRouter = Router(); // monté sous /api/bornes (admin, technicien)
export const coutsRouter = Router(); // /api/couts
export const interventionsRouter = Router(); // /api/interventions
export const rentabiliteRouter = Router(); // /api/rentabilite (admin)

const jour = z.iso.date().transform((v) => new Date(`${v}T00:00:00Z`));
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const montant = z.number().int().min(0);

// ─── Coûts ──────────────────────────────────────────────────

// GET /api/bornes/:id/couts
coutsBornesRouter.get(
  "/:id/couts",
  asynchrone(async (req, res) => {
    res.json(
      await prisma.coutBorne.findMany({
        where: { borneId: Number(req.params.id) },
        include: { intervention: { select: { id: true, motif: true } } },
        orderBy: { date: "desc" },
        take: 300,
      })
    );
  })
);

// POST /api/bornes/:id/couts { date, categorie, montantCents, libelle? }
coutsBornesRouter.post(
  "/:id/couts",
  asynchrone(async (req, res) => {
    const data = z
      .object({ date: jour, categorie: z.enum(CategorieCout), montantCents: montant.refine((v) => v > 0, "Montant nul"), libelle: z.string().trim().nullable().optional() })
      .parse(req.body);
    res.status(201).json(await prisma.coutBorne.create({ data: { ...data, borneId: Number(req.params.id) } }));
  })
);

// DELETE /api/couts/:id
coutsRouter.delete(
  "/:id",
  asynchrone(async (req, res) => {
    await prisma.coutBorne.delete({ where: { id: Number(req.params.id) } });
    res.status(204).end();
  })
);

// ─── Interventions SAV ──────────────────────────────────────

const interventionSchema = z.object({
  date: instant,
  motif: z.string().trim().min(2),
  compteRendu: z.string().trim().nullable().optional(),
  enPanneDepuis: instant.nullable().optional(),
  resolueLe: instant.nullable().optional(),
  technicienId: z.number().int().positive().nullable().optional(),
  // Coût de l'intervention (déplacement, main d'œuvre, pièces) : enregistré comme coût de la borne
  coutCents: montant.nullable().optional(),
});

// GET /api/bornes/:id/interventions
coutsBornesRouter.get(
  "/:id/interventions",
  asynchrone(async (req, res) => {
    const interventions = await prisma.intervention.findMany({
      where: { borneId: Number(req.params.id) },
      include: { technicien: { select: { id: true, nom: true, prenom: true } }, couts: { select: { montantCents: true } } },
      orderBy: { date: "desc" },
    });
    res.json(interventions.map(({ couts, ...i }) => ({ ...i, coutCents: couts.reduce((s, c) => s + c.montantCents, 0) })));
  })
);

// POST /api/bornes/:id/interventions
coutsBornesRouter.post(
  "/:id/interventions",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const borneId = Number(req.params.id);
    const { coutCents, technicienId, ...data } = interventionSchema.parse(req.body);
    const intervention = await prisma.intervention.create({
      data: {
        ...data,
        borneId,
        // Par défaut : le technicien qui saisit
        technicienId: technicienId ?? (req.utilisateur?.role === "TECHNICIEN" ? req.utilisateur.id : null),
        couts: coutCents
          ? { create: { borneId, date: jourEtHeureLocaux(data.date).jour, categorie: "INTERVENTION", montantCents: coutCents, libelle: data.motif } }
          : undefined,
      },
    });
    res.status(201).json(intervention);
  })
);

// PATCH /api/interventions/:id
interventionsRouter.patch(
  "/:id",
  asynchrone(async (req, res) => {
    const id = Number(req.params.id);
    const { coutCents, ...patch } = interventionSchema.partial().parse(req.body);
    const intervention = await prisma.$transaction(async (db) => {
      const i = await db.intervention.update({ where: { id }, data: patch });
      if (coutCents !== undefined) {
        await db.coutBorne.deleteMany({ where: { interventionId: id } });
        if (coutCents) {
          await db.coutBorne.create({
            data: { borneId: i.borneId, interventionId: id, date: jourEtHeureLocaux(i.date).jour, categorie: "INTERVENTION", montantCents: coutCents, libelle: i.motif },
          });
        }
      }
      return i;
    });
    res.json(intervention);
  })
);

// DELETE /api/interventions/:id (et son coût)
interventionsRouter.delete(
  "/:id",
  asynchrone(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.$transaction([prisma.coutBorne.deleteMany({ where: { interventionId: id } }), prisma.intervention.delete({ where: { id } })]);
    res.status(204).end();
  })
);

// ─── Achat et rentabilité (admin) ───────────────────────────

// PATCH /api/rentabilite/bornes/:id/achat { coutAchatCents, dureeAmortissementMois, dateMiseEnService }
rentabiliteRouter.patch(
  "/bornes/:id/achat",
  asynchrone(async (req, res) => {
    const data = z
      .object({
        coutAchatCents: montant.nullable(),
        dureeAmortissementMois: z.number().int().min(1).max(240).nullable(),
        dateMiseEnService: jour.nullable(),
      })
      .parse(req.body);
    res.json(await prisma.borne.update({ where: { id: Number(req.params.id) }, data, select: { id: true, coutAchatCents: true, dureeAmortissementMois: true, dateMiseEnService: true } }));
  })
);

// GET /api/rentabilite?du=&au= — toutes les bornes
rentabiliteRouter.get(
  "/",
  asynchrone(async (req, res) => {
    const f = lireFiltres(req.query);
    const bornes = await prisma.borne.findMany({
      where: { statut: { not: "REFORMEE" } },
      include: {
        gamme: { select: { libelle: true } },
        affectations: { where: { fin: null }, include: { lieu: { select: { id: true, enseigne: true } } } },
      },
      orderBy: { identifiant: "asc" },
    });
    const aujourdhui = jourEtHeureLocaux(new Date()).jour;
    const lignes = await Promise.all(
      bornes.map(async (b) => {
        const [r, roi] = await Promise.all([rentabiliteBorne(b.id, f.du, f.au), retourInvestissement(b.id, aujourdhui)]);
        return {
          borneId: b.id,
          identifiant: b.identifiant,
          gamme: b.gamme.libelle,
          lieu: b.affectations[0]?.lieu ?? null,
          ...r,
          roi: roi && { partRemboursee: roi.partRemboursee, dateRetour: roi.dateRetour, moisRestants: roi.moisRestants, coutAchatCents: roi.coutAchatCents },
        };
      })
    );
    const somme = (k: "caHtCents" | "commissionsCents" | "coutsCents" | "amortissementCents" | "margeNetteCents") => lignes.reduce((s, l) => s + l[k], 0);
    res.json({
      periode: { du: ymd(f.du), au: ymd(f.au) },
      bornes: lignes,
      total: {
        caHtCents: somme("caHtCents"),
        commissionsCents: somme("commissionsCents"),
        coutsCents: somme("coutsCents"),
        amortissementCents: somme("amortissementCents"),
        margeNetteCents: somme("margeNetteCents"),
      },
    });
  })
);

// GET /api/rentabilite/bornes/:id?du=&au= — détail d'une borne, avec le retour sur investissement
rentabiliteRouter.get(
  "/bornes/:id",
  asynchrone(async (req, res) => {
    const f = lireFiltres(req.query);
    const id = Number(req.params.id);
    const borne = await prisma.borne.findUniqueOrThrow({ where: { id }, select: { coutAchatCents: true, dureeAmortissementMois: true, dateMiseEnService: true } });
    const [rentabilite, roi] = await Promise.all([rentabiliteBorne(id, f.du, f.au), retourInvestissement(id, jourEtHeureLocaux(new Date()).jour)]);
    res.json({ periode: { du: ymd(f.du), au: ymd(f.au) }, achat: borne, rentabilite, roi });
  })
);
