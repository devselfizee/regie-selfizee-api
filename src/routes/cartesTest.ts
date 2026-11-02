import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { appliquerCartesTest } from "../ingestion/cartesTest.js";

// Cartes de test (demande de Sébastien, 02/11/2026) : 4 derniers chiffres et un nom
// (« Carte Crédit Agricole Sébastien »). Leurs ventes sortent des chiffres réels et sont montrées à part.
export const cartesTestRouter = Router();

const corps = z.object({
  derniersChiffres: z.string().trim().regex(/^\d{4}$/, "4 chiffres attendus"),
  nom: z.string().trim().min(1).max(120),
});

const enDouble = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// GET /api/cartes-test — les cartes, avec ce qui a été payé avec chacune (ventes payées moins remboursements)
cartesTestRouter.get(
  "/",
  asynchrone(async (_req, res) => {
    const [cartes, ventes] = await Promise.all([
      prisma.carteTest.findMany({ orderBy: { createdAt: "asc" }, include: { creePar: { select: { prenom: true, nom: true } } } }),
      prisma.$queryRaw<{ carte_fin: string; nb: number; ca: number; derniere: Date | null }[]>`
        SELECT carte_fin,
          count(*) FILTER (WHERE statut = 'ACCEPTEE' AND montant_ttc_cents > 0)::int nb,
          coalesce(sum(montant_ttc_cents) FILTER (WHERE statut = 'ACCEPTEE' AND montant_ttc_cents > 0), 0)::int ca,
          max(horodatage) derniere
        FROM transactions WHERE test AND carte_fin IS NOT NULL GROUP BY carte_fin`,
    ]);
    const parChiffres = new Map(ventes.map((v) => [v.carte_fin, v]));
    res.json(
      cartes.map((c) => {
        const v = parChiffres.get(c.derniersChiffres);
        return { ...c, nbVentes: v?.nb ?? 0, caTtcCents: v?.ca ?? 0, derniereVente: v?.derniere ?? null };
      })
    );
  })
);

// POST /api/cartes-test { derniersChiffres, nom }
cartesTestRouter.post(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const d = corps.parse(req.body);
    const carte = await prisma.carteTest
      .create({ data: { ...d, creeParId: req.utilisateur?.id ?? null } })
      .catch((e) => {
        throw enDouble(e) ? new HttpError(409, "EN_DOUBLE", `Une carte se terminant par ${d.derniersChiffres} est déjà enregistrée`) : e;
      });
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "carte_test", entiteId: String(carte.id), action: "CREATION", apres: d } });
    res.status(201).json({ ...carte, ventesMarquees: await appliquerCartesTest([d.derniersChiffres]) });
  })
);

// PUT /api/cartes-test/:id { derniersChiffres, nom }
cartesTestRouter.put(
  "/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = Number(req.params.id);
    const d = corps.parse(req.body);
    const avant = await prisma.carteTest.findUnique({ where: { id } });
    if (!avant) throw new HttpError(404, "INTROUVABLE");
    const carte = await prisma.carteTest.update({ where: { id }, data: d }).catch((e) => {
      throw enDouble(e) ? new HttpError(409, "EN_DOUBLE", `Une carte se terminant par ${d.derniersChiffres} est déjà enregistrée`) : e;
    });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "carte_test", entiteId: String(id), action: "MODIFICATION", avant: { derniersChiffres: avant.derniersChiffres, nom: avant.nom }, apres: d },
    });
    res.json({ ...carte, ventesMarquees: await appliquerCartesTest([avant.derniersChiffres, d.derniersChiffres]) });
  })
);

// DELETE /api/cartes-test/:id — ses ventes redeviennent des ventes réelles
cartesTestRouter.delete(
  "/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = Number(req.params.id);
    const avant = await prisma.carteTest.findUnique({ where: { id } });
    if (!avant) throw new HttpError(404, "INTROUVABLE");
    await prisma.carteTest.delete({ where: { id } });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "carte_test", entiteId: String(id), action: "SUPPRESSION", avant: { derniersChiffres: avant.derniersChiffres, nom: avant.nom } },
    });
    res.json({ ventesReintegrees: await appliquerCartesTest([avant.derniersChiffres]) });
  })
);
