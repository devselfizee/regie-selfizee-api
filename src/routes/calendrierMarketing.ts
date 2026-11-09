import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { type UtilisateurRequest } from "../middleware/utilisateur.js";
import { occurrencesEntre } from "../calendrier/marketing.js";
import { requirePerm } from "../middleware/permissions.js";

// Calendrier marketing (demande de Sébastien, 02/11/2026) : liste modifiable des temps forts commerciaux.
export const calendrierMarketingRouter = Router();

const jour = z.iso.date();

// GET /api/calendrier-marketing — tous les événements (Paramètres)
// GET /api/calendrier-marketing?du=&au= — leurs occurrences sur la période (courbes, calendrier des ventes)
calendrierMarketingRouter.get(
  "/",
  asynchrone(async (req, res) => {
    const p = z.object({ du: jour.optional(), au: jour.optional() }).parse(req.query);
    if (p.du && p.au) return res.json(await occurrencesEntre(new Date(`${p.du}T00:00:00Z`), new Date(`${p.au}T00:00:00Z`)));
    res.json(await prisma.evenementMarketing.findMany({ orderBy: [{ annuel: "desc" }, { debut: "asc" }] }));
  })
);

const corps = z
  .object({ nom: z.string().trim().min(1).max(120), debut: jour, fin: jour.nullable().optional(), annuel: z.boolean().default(false) })
  .refine((d) => !d.fin || d.fin >= d.debut, { message: "La fin doit suivre le début", path: ["fin"] });
const donnees = (d: z.infer<typeof corps>) => ({
  nom: d.nom,
  debut: new Date(`${d.debut}T00:00:00Z`),
  // Un jour par défaut
  fin: new Date(`${d.fin ?? d.debut}T00:00:00Z`),
  annuel: d.annuel,
});

// POST /api/calendrier-marketing { nom, debut, fin?, annuel? }
calendrierMarketingRouter.post(
  "/",
  requirePerm("marketing.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    res.status(201).json(await prisma.evenementMarketing.create({ data: donnees(corps.parse(req.body)) }));
  })
);

// PUT /api/calendrier-marketing/:id
calendrierMarketingRouter.put(
  "/:id",
  requirePerm("marketing.edit"),
  asynchrone(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.evenementMarketing.findUnique({ where: { id } }))) throw new HttpError(404, "INTROUVABLE");
    res.json(await prisma.evenementMarketing.update({ where: { id }, data: donnees(corps.parse(req.body)) }));
  })
);

// DELETE /api/calendrier-marketing/:id
calendrierMarketingRouter.delete(
  "/:id",
  requirePerm("marketing.edit"),
  asynchrone(async (req, res) => {
    await prisma.evenementMarketing.delete({ where: { id: Number(req.params.id) } });
    res.status(204).end();
  })
);
