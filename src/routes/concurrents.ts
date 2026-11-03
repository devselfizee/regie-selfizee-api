import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { geocoder } from "../lib/geocodage.js";

// Concurrents (demande de Sébastien, 03/11/2026) : la liste des concurrents (cabine ou borne), leurs emplacements
// connus (carte des prospects) et un import en masse de ces emplacements.
export const concurrentsRouter = Router();

const corps = z.object({
  nom: z.string().trim().min(1).max(120),
  typeMateriel: z.enum(["CABINE", "BORNE"]),
  siteWeb: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
const enDouble = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// GET /api/concurrents — avec le nombre d'emplacements connus et de prospects où ils sont en place
concurrentsRouter.get(
  "/",
  asynchrone(async (_req, res) => {
    const c = await prisma.concurrent.findMany({ orderBy: { nom: "asc" }, include: { _count: { select: { emplacements: true, lieux: true } } } });
    res.json(c.map(({ _count, ...x }) => ({ ...x, nbEmplacements: _count.emplacements, nbLieux: _count.lieux })));
  })
);

// GET /api/concurrents/emplacements?concurrentId=&typeMateriel= — emplacements placés sur la carte
concurrentsRouter.get(
  "/emplacements",
  asynchrone(async (req, res) => {
    const f = z.object({ concurrentId: z.coerce.number().int().optional(), typeMateriel: z.enum(["CABINE", "BORNE"]).optional() }).parse(req.query);
    const e = await prisma.emplacementConcurrent.findMany({
      where: { ...(f.concurrentId ? { concurrentId: f.concurrentId } : {}), ...(f.typeMateriel ? { concurrent: { typeMateriel: f.typeMateriel } } : {}) },
      include: { concurrent: { select: { id: true, nom: true, typeMateriel: true } } },
      orderBy: [{ concurrentId: "asc" }, { ville: "asc" }],
    });
    res.json(e.map((x) => ({ ...x, latitude: x.latitude === null ? null : Number(x.latitude), longitude: x.longitude === null ? null : Number(x.longitude) })));
  })
);

concurrentsRouter.post(
  "/",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone(async (req, res) => {
    const d = corps.parse(req.body);
    const c = await prisma.concurrent.create({ data: d }).catch((e) => {
      throw enDouble(e) ? new HttpError(409, "EN_DOUBLE", `« ${d.nom} » existe déjà`) : e;
    });
    res.status(201).json(c);
  })
);

concurrentsRouter.put(
  "/:id",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone(async (req, res) => {
    const d = corps.parse(req.body);
    const c = await prisma.concurrent.update({ where: { id: Number(req.params.id) }, data: d }).catch((e) => {
      throw enDouble(e) ? new HttpError(409, "EN_DOUBLE", `« ${d.nom} » existe déjà`) : e;
    });
    res.json(c);
  })
);

// DELETE /api/concurrents/:id — ses emplacements avec ; les prospects gardent « concurrent en place » sans le nom choisi
concurrentsRouter.delete(
  "/:id",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    await prisma.concurrent.delete({ where: { id: Number(req.params.id) } });
    res.status(204).end();
  })
);

const ligneImport = z.object({
  nom: z.string().trim().min(1).max(200),
  adresse: z.string().trim().max(300).nullable().optional(),
  codePostal: z.string().trim().max(20).nullable().optional(),
  ville: z.string().trim().max(120).nullable().optional(),
  pays: z.string().trim().max(60).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

// POST /api/concurrents/:id/emplacements/import { lignes: [...], remplacer?: boolean, source? }
// Les lignes sans position sont placées d'après leur adresse (Base Adresse Nationale : France seulement).
concurrentsRouter.post(
  "/:id/emplacements/import",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const concurrentId = Number(req.params.id);
    const d = z.object({ lignes: z.array(ligneImport).min(1).max(5000), remplacer: z.boolean().default(false), source: z.string().trim().max(200).optional() }).parse(req.body);
    if (!(await prisma.concurrent.findUnique({ where: { id: concurrentId } }))) throw new HttpError(404, "INTROUVABLE");

    const introuvables: string[] = [];
    const lignes: Prisma.EmplacementConcurrentCreateManyInput[] = [];
    for (const l of d.lignes) {
      let { latitude, longitude } = l;
      if ((latitude == null || longitude == null) && (!l.pays || /^fr/i.test(l.pays))) {
        const p = await geocoder(l);
        if (p) ({ latitude, longitude } = p);
      }
      if (latitude == null || longitude == null) introuvables.push(l.nom);
      lignes.push({ ...l, latitude: latitude ?? null, longitude: longitude ?? null, concurrentId, source: d.source ?? "import" });
    }
    await prisma.$transaction(async (db) => {
      if (d.remplacer) await db.emplacementConcurrent.deleteMany({ where: { concurrentId } });
      await db.emplacementConcurrent.createMany({ data: lignes });
    });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "concurrent", entiteId: String(concurrentId), action: "IMPORT_EMPLACEMENTS", apres: { nb: lignes.length, remplacer: d.remplacer, source: d.source } },
    });
    res.status(201).json({ importes: lignes.length, places: lignes.length - introuvables.length, introuvables });
  })
);

// DELETE /api/concurrents/emplacements/:id
concurrentsRouter.delete(
  "/emplacements/:id",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone(async (req, res) => {
    await prisma.emplacementConcurrent.delete({ where: { id: Number(req.params.id) } });
    res.status(204).end();
  })
);
