import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { geocoder } from "../lib/geocodage.js";
import { devinerCategorie } from "../concurrents/categorie.js";

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

/** Code TYPE_LIEU → id, pour la catégorie devinée d'après le nom */
async function typesLieuParCode() {
  const v = await prisma.refValeur.findMany({ where: { categorie: "TYPE_LIEU", actif: true }, select: { id: true, code: true } });
  return new Map(v.map((x) => [x.code, x.id]));
}

// GET /api/concurrents — avec le nombre d'emplacements connus et de prospects où ils sont en place
concurrentsRouter.get(
  "/",
  asynchrone(async (_req, res) => {
    const c = await prisma.concurrent.findMany({ orderBy: { nom: "asc" }, include: { _count: { select: { emplacements: true, lieux: true } } } });
    res.json(c.map(({ _count, ...x }) => ({ ...x, nbEmplacements: _count.emplacements, nbLieux: _count.lieux })));
  })
);

// GET /api/concurrents/emplacements?concurrentId=&typeMateriel=&typeLieuId= (0 = sans catégorie)
concurrentsRouter.get(
  "/emplacements",
  asynchrone(async (req, res) => {
    const f = z
      .object({ concurrentId: z.coerce.number().int().optional(), typeMateriel: z.enum(["CABINE", "BORNE"]).optional(), typeLieuId: z.coerce.number().int().optional() })
      .parse(req.query);
    const e = await prisma.emplacementConcurrent.findMany({
      where: {
        ...(f.concurrentId ? { concurrentId: f.concurrentId } : {}),
        ...(f.typeMateriel ? { concurrent: { typeMateriel: f.typeMateriel } } : {}),
        ...(f.typeLieuId !== undefined ? { typeLieuId: f.typeLieuId || null } : {}),
      },
      include: {
        concurrent: { select: { id: true, nom: true, typeMateriel: true } },
        lieu: { select: { id: true, statut: true } },
        typeLieu: { select: { id: true, libelle: true } },
      },
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
    const types = await typesLieuParCode();
    const lignes: Prisma.EmplacementConcurrentCreateManyInput[] = [];
    for (const l of d.lignes) {
      let { latitude, longitude } = l;
      if ((latitude == null || longitude == null) && (!l.pays || /^fr/i.test(l.pays))) {
        const p = await geocoder(l);
        if (p) ({ latitude, longitude } = p);
      }
      if (latitude == null || longitude == null) introuvables.push(l.nom);
      const categorie = devinerCategorie(l.nom);
      lignes.push({ ...l, latitude: latitude ?? null, longitude: longitude ?? null, concurrentId, source: d.source ?? "import", typeLieuId: categorie ? (types.get(categorie) ?? null) : null });
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

// POST /api/concurrents/emplacements/categoriser — catégorie devinée d'après le nom, pour les emplacements qui n'en ont pas
// (les emplacements importés avant la catégorie, ou ceux qu'aucune règle ne reconnaissait encore)
concurrentsRouter.post(
  "/emplacements/categoriser",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const types = await typesLieuParCode();
    const sans = await prisma.emplacementConcurrent.findMany({ where: { typeLieuId: null }, select: { id: true, nom: true } });
    const parType = new Map<number, number[]>();
    for (const e of sans) {
      const id = types.get(devinerCategorie(e.nom) ?? "");
      if (id) parType.set(id, [...(parType.get(id) ?? []), e.id]);
    }
    for (const [typeLieuId, ids] of parType) await prisma.emplacementConcurrent.updateMany({ where: { id: { in: ids } }, data: { typeLieuId } });
    const categorises = [...parType.values()].reduce((s, ids) => s + ids.length, 0);
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "concurrent", entiteId: "*", action: "CATEGORISER_EMPLACEMENTS", apres: { categorises } } });
    res.json({ categorises, restants: sans.length - categorises });
  })
);

// PATCH /api/concurrents/emplacements/:id { typeLieuId } — catégorie corrigée à la main (null = à catégoriser)
concurrentsRouter.patch(
  "/emplacements/:id",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone(async (req, res) => {
    const d = z.object({ typeLieuId: z.number().int().nullable() }).parse(req.body);
    if (d.typeLieuId !== null && !(await prisma.refValeur.findFirst({ where: { id: d.typeLieuId, categorie: "TYPE_LIEU" } })))
      throw new HttpError(400, "TYPE_LIEU_INCONNU", "Type de lieu inconnu");
    const e = await prisma.emplacementConcurrent.update({ where: { id: Number(req.params.id) }, data: { typeLieuId: d.typeLieuId } });
    res.json(e);
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

// Pays écrit dans l'adresse importée → code de la fiche lieu
const CODES_PAYS: Record<string, string> = {
  france: "FR", belgique: "BE", suisse: "CH", luxembourg: "LU", allemagne: "DE", italie: "IT", espagne: "ES", monaco: "MC", "pays-bas": "NL", "royaume-uni": "GB",
};

// POST /api/concurrents/emplacements/prospects { ids, typeLieuId? } — une fiche prospect par emplacement (demande de
// Sébastien) : nom, adresse, position et catégorie repris, concurrent en place renseigné. typeLieuId sert aux emplacements
// sans catégorie (obligatoire s'il y en a). Un emplacement déjà transformé est ignoré.
concurrentsRouter.post(
  "/emplacements/prospects",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const d = z.object({ ids: z.array(z.number().int()).min(1).max(500), typeLieuId: z.number().int().nullable().optional() }).parse(req.body);
    if (d.typeLieuId != null && !(await prisma.refValeur.findFirst({ where: { id: d.typeLieuId, categorie: "TYPE_LIEU" } })))
      throw new HttpError(400, "TYPE_LIEU_INCONNU", "Type de lieu inconnu");
    const emplacements = await prisma.emplacementConcurrent.findMany({ where: { id: { in: d.ids }, lieuId: null } });
    if (d.typeLieuId == null && emplacements.some((e) => e.typeLieuId === null))
      throw new HttpError(400, "TYPE_LIEU_REQUIS", "Choisissez un type de lieu pour les emplacements sans catégorie");
    const crees: { emplacementId: number; lieuId: number }[] = [];
    for (const e of emplacements) {
      const lieu = await prisma.$transaction(async (db) => {
        const l = await db.lieu.create({
          data: {
            statut: "PROSPECT",
            enseigne: e.nom,
            raisonSociale: e.nom,
            adresse: e.adresse,
            codePostal: e.codePostal,
            ville: e.ville,
            pays: CODES_PAYS[(e.pays ?? "France").toLowerCase()] ?? "FR",
            latitude: e.latitude,
            longitude: e.longitude,
            typeLieuId: (e.typeLieuId ?? d.typeLieuId)!,
            concurrentEnPlace: true,
            concurrentId: e.concurrentId,
            // Un commercial reste responsable des prospects qu'il crée
            commercialId: req.utilisateur?.role === "COMMERCIAL" ? req.utilisateur.id : null,
          },
        });
        await db.emplacementConcurrent.update({ where: { id: e.id }, data: { lieuId: l.id } });
        await db.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "lieu", entiteId: String(l.id), action: "CREATION", apres: { depuisEmplacementConcurrent: e.id } } });
        return l;
      });
      crees.push({ emplacementId: e.id, lieuId: lieu.id });
    }
    res.status(201).json({ crees: crees.length, dejaProspects: d.ids.length - emplacements.length, lieux: crees });
  })
);
