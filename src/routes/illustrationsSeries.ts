import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { MAX_PAR_SERIE, preparerIllustration } from "../config-evenement/illustrations.js";

// Bibliothèque des séries d'illustrations « type » (mémo ILLUSTRATIONS-ADMIN-WEB § 3a) : séries communes
// gérées par Selfizee (mariage, corporate…), choisies dans les fiches événement et copiées dans le zip.
// Festif et chic restent les séries embarquées dans le logiciel de la borne. Réservé aux admins.
export const illustrationsSeriesRouter = Router();
const admin = exiger("ADMIN");

const enDataUrl = (b: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(b).toString("base64")}`;
const nomSchema = z.string().trim().min(1).max(80);
const idParam = (v: unknown) => z.coerce.number().int().positive().parse(v);

async function serie(id: number) {
  const s = await prisma.illustrationSerie.findUnique({ where: { id } });
  if (!s) throw new HttpError(404, "INTROUVABLE", "Série introuvable");
  return s;
}

// GET /api/illustrations-series — les séries, avec leur nombre de photos par forme et un aperçu
illustrationsSeriesRouter.get(
  "/",
  admin,
  asynchrone(async (_req, res) => {
    const series = await prisma.illustrationSerie.findMany({
      orderBy: { nom: "asc" },
      include: { images: { select: { forme: true, vignette: true }, orderBy: { id: "asc" } } },
    });
    res.json(
      series.map(({ images, ...s }) => ({
        ...s,
        nbImages: images.length,
        formes: { carre: images.filter((i) => i.forme === "carre").length, portrait: images.filter((i) => i.forme === "portrait").length, paysage: images.filter((i) => i.forme === "paysage").length },
        apercus: images.slice(0, 4).map((i) => enDataUrl(i.vignette)),
      }))
    );
  })
);

// POST /api/illustrations-series { nom } — nouvelle série (vide)
illustrationsSeriesRouter.post(
  "/",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { nom } = z.object({ nom: nomSchema }).parse(req.body);
    const s = await prisma.illustrationSerie.create({ data: { nom } });
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "illustration_serie", entiteId: String(s.id), action: "CREATION", apres: { nom } } });
    res.status(201).json({ ...s, nbImages: 0, formes: { carre: 0, portrait: 0, paysage: 0 }, apercus: [] });
  })
);

// PATCH /api/illustrations-series/:sid { nom?, actif? } — renommer, retirer des choix (sans la supprimer)
illustrationsSeriesRouter.patch(
  "/:sid",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = idParam(req.params.sid);
    const saisie = z.object({ nom: nomSchema.optional(), actif: z.boolean().optional() }).parse(req.body);
    const avant = await serie(id);
    const s = await prisma.illustrationSerie.update({ where: { id }, data: saisie });
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "illustration_serie", entiteId: String(id), action: "MODIFICATION", avant: { nom: avant.nom, actif: avant.actif }, apres: saisie } });
    res.json(s);
  })
);

// DELETE /api/illustrations-series/:sid — supprime la série et ses photos ; les événements qui la
// choisissaient exportent la série festive du logiciel
illustrationsSeriesRouter.delete(
  "/:sid",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = idParam(req.params.sid);
    const avant = await serie(id);
    await prisma.illustrationSerie.delete({ where: { id } });
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "illustration_serie", entiteId: String(id), action: "SUPPRESSION", avant: { nom: avant.nom } } });
    res.status(204).end();
  })
);

// GET /api/illustrations-series/:sid/images — les photos de la série (vignettes)
illustrationsSeriesRouter.get(
  "/:sid/images",
  admin,
  asynchrone(async (req, res) => {
    const id = idParam(req.params.sid);
    await serie(id);
    const images = await prisma.illustrationSerieImage.findMany({
      where: { serieId: id },
      select: { id: true, forme: true, largeur: true, hauteur: true, vignette: true },
      orderBy: { id: "asc" },
    });
    res.json(images.map((i) => ({ ...i, vignette: enDataUrl(i.vignette) })));
  })
);

// POST /api/illustrations-series/:sid/images { image (data URL) } — ajoute une photo, réduite et rangée par forme
illustrationsSeriesRouter.post(
  "/:sid/images",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = idParam(req.params.sid);
    const { image } = z.object({ image: z.string().regex(/^data:image\/(jpeg|png|webp|bmp);base64,[A-Za-z0-9+/=]+$/, "Image JPEG, PNG, WebP ou BMP attendue") }).parse(req.body);
    await serie(id);
    if ((await prisma.illustrationSerieImage.count({ where: { serieId: id } })) >= MAX_PAR_SERIE)
      throw new HttpError(400, "TROP_D_ILLUSTRATIONS", `${MAX_PAR_SERIE} photos au plus par série : retirez-en une d'abord.`);
    let p;
    try {
      p = await preparerIllustration(Buffer.from(image.slice(image.indexOf(",") + 1), "base64"));
    } catch {
      throw new HttpError(400, "IMAGE_ILLISIBLE", "Image illisible : JPEG, PNG, WebP ou BMP.");
    }
    const creee = await prisma.illustrationSerieImage.create({
      data: { serieId: id, forme: p.forme, largeur: p.largeur, hauteur: p.hauteur, image: new Uint8Array(p.image), vignette: new Uint8Array(p.vignette) },
      select: { id: true, forme: true, largeur: true, hauteur: true, vignette: true },
    });
    await prisma.illustrationSerie.update({ where: { id }, data: { updatedAt: new Date() } });
    res.status(201).json({ ...creee, vignette: enDataUrl(creee.vignette) });
  })
);

// DELETE /api/illustrations-series/:sid/images/:iid — retire une photo de la série
illustrationsSeriesRouter.delete(
  "/:sid/images/:iid",
  admin,
  asynchrone(async (req, res) => {
    const id = idParam(req.params.sid);
    const iid = idParam(req.params.iid);
    const { count } = await prisma.illustrationSerieImage.deleteMany({ where: { id: iid, serieId: id } });
    if (!count) throw new HttpError(404, "INTROUVABLE", "Photo introuvable");
    res.status(204).end();
  })
);
