import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { type UtilisateurRequest } from "../middleware/utilisateur.js";
import { chemins, cible, evenementDe, toucher } from "../config-evenement/acces.js";
import { CIBLES, MAX_PAR_SERIE, preparerIllustration } from "../config-evenement/illustrations.js";
import { reglagesSchema } from "../config-evenement/reglages.js";
import { requirePerm } from "../middleware/permissions.js";

// Photos d'exemple d'un événement (illustrations des cases des cadres, kit nightlife) : série des cadres
// (page de choix du format) et série de l'accueil. Réservé aux admins, monté sous /api/lieux comme la
// fiche événement, pour l'événement habituel et les ponctuels. Copiées dans le zip (zip.ts).
export const illustrationsEvenementRouter = Router();
const voir = requirePerm("evenements.view");
const modifier = requirePerm("evenements.edit");

const enDataUrl = (b: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(b).toString("base64")}`;
const resume = { id: true, cible: true, forme: true, largeur: true, hauteur: true, vignette: true } as const;
const versClient = <T extends { vignette: Uint8Array }>(i: T) => ({ ...i, vignette: enDataUrl(i.vignette) });

async function evenementEnregistre(lieuId: number, eid: number | null) {
  const e = await evenementDe(lieuId, eid);
  if (!e) throw new HttpError(400, "PAS_ENCORE_ENREGISTRE", "Enregistrez d'abord la fiche événement");
  return e;
}

// GET …/illustrations — les photos de l'événement (vignettes), série des cadres puis de l'accueil
illustrationsEvenementRouter.get(
  chemins("/illustrations"),
  voir,
  asynchrone(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const e = await evenementDe(lieuId, eid);
    const liste = e ? await prisma.illustrationEvenement.findMany({ where: { configEvenementId: e.id }, select: resume, orderBy: { id: "asc" } }) : [];
    res.json(liste.map(versClient));
  })
);

// POST …/illustrations { cible, image (data URL) } — ajoute une photo : réduite (1200 px), rangée par forme
illustrationsEvenementRouter.post(
  chemins("/illustrations"),
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const saisie = z
      .object({ cible: z.enum(CIBLES), image: z.string().regex(/^data:image\/(jpeg|png|webp|bmp);base64,[A-Za-z0-9+/=]+$/, "Image JPEG, PNG, WebP ou BMP attendue") })
      .parse(req.body);
    const e = await evenementEnregistre(lieuId, eid);
    const deja = await prisma.illustrationEvenement.count({ where: { configEvenementId: e.id, cible: saisie.cible } });
    if (deja >= MAX_PAR_SERIE) throw new HttpError(400, "TROP_D_ILLUSTRATIONS", `${MAX_PAR_SERIE} photos au plus par série : retirez-en une d'abord.`);
    let preparee;
    try {
      preparee = await preparerIllustration(Buffer.from(saisie.image.slice(saisie.image.indexOf(",") + 1), "base64"));
    } catch {
      throw new HttpError(400, "IMAGE_ILLISIBLE", "Image illisible : JPEG, PNG, WebP ou BMP.");
    }
    const creee = await prisma.illustrationEvenement.create({
      data: { configEvenementId: e.id, cible: saisie.cible, forme: preparee.forme, largeur: preparee.largeur, hauteur: preparee.hauteur, image: new Uint8Array(preparee.image), vignette: new Uint8Array(preparee.vignette) },
      select: resume,
    });
    await toucher(e.id);
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "illustration_evenement", entiteId: `${e.id}:${creee.id}`, action: "CREATION", apres: { cible: creee.cible, forme: creee.forme } },
    });
    res.status(201).json(versClient(creee));
  })
);

// DELETE …/illustrations/:iid — retire une photo
illustrationsEvenementRouter.delete(
  chemins("/illustrations/:iid"),
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const iid = z.coerce.number().int().positive().parse(req.params.iid);
    const e = await evenementEnregistre(lieuId, eid);
    const { count } = await prisma.illustrationEvenement.deleteMany({ where: { id: iid, configEvenementId: e.id } });
    if (!count) throw new HttpError(404, "INTROUVABLE", "Photo introuvable");
    await toucher(e.id);
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "illustration_evenement", entiteId: `${e.id}:${iid}`, action: "SUPPRESSION" } });
    res.status(204).end();
  })
);

// ─── Photos du client : sur le lieu, reprises par tous ses événements ───

const imageSchema = z.string().regex(/^data:image\/(jpeg|png|webp|bmp);base64,[A-Za-z0-9+/=]+$/, "Image JPEG, PNG, WebP ou BMP attendue");
const resumeLieu = { id: true, forme: true, largeur: true, hauteur: true, vignette: true } as const;

/** Les événements du lieu qui montrent les photos du client passent en « modifications non publiées ». */
async function toucherClient(lieuId: number) {
  const evenements = await prisma.configEvenement.findMany({ where: { lieuId }, select: { id: true, reglages: true } });
  const concernes = evenements.filter((e) => {
    const l = reglagesSchema.safeParse(e.reglages).data?.lieu;
    return l?.illustrations === "client" || l?.illustrationsAccueil === "client";
  });
  if (concernes.length) await prisma.configEvenement.updateMany({ where: { id: { in: concernes.map((e) => e.id) } }, data: { updatedAt: new Date() } });
}

async function ajouterPhotoClient(lieuId: number, preparee: Awaited<ReturnType<typeof preparerIllustration>>) {
  return prisma.illustrationLieu.create({
    data: { lieuId, forme: preparee.forme, largeur: preparee.largeur, hauteur: preparee.hauteur, image: new Uint8Array(preparee.image), vignette: new Uint8Array(preparee.vignette) },
    select: resumeLieu,
  });
}

// GET /api/lieux/:id/illustrations-client — les photos du client (vignettes)
illustrationsEvenementRouter.get(
  "/:id/illustrations-client",
  voir,
  asynchrone(async (req, res) => {
    const lieuId = z.coerce.number().int().positive().parse(req.params.id);
    const liste = await prisma.illustrationLieu.findMany({ where: { lieuId }, select: resumeLieu, orderBy: { id: "asc" } });
    res.json(liste.map(versClient));
  })
);

// POST /api/lieux/:id/illustrations-client { image (data URL) } — ajoute une photo du client
illustrationsEvenementRouter.post(
  "/:id/illustrations-client",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = z.coerce.number().int().positive().parse(req.params.id);
    const { image } = z.object({ image: imageSchema }).parse(req.body);
    if (!(await prisma.lieu.findUnique({ where: { id: lieuId }, select: { id: true } }))) throw new HttpError(404, "INTROUVABLE");
    if ((await prisma.illustrationLieu.count({ where: { lieuId } })) >= MAX_PAR_SERIE)
      throw new HttpError(400, "TROP_D_ILLUSTRATIONS", `${MAX_PAR_SERIE} photos au plus : retirez-en une d'abord.`);
    let preparee;
    try {
      preparee = await preparerIllustration(Buffer.from(image.slice(image.indexOf(",") + 1), "base64"));
    } catch {
      throw new HttpError(400, "IMAGE_ILLISIBLE", "Image illisible : JPEG, PNG, WebP ou BMP.");
    }
    const creee = await ajouterPhotoClient(lieuId, preparee);
    await toucherClient(lieuId);
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "illustration_lieu", entiteId: `${lieuId}:${creee.id}`, action: "CREATION", apres: { forme: creee.forme } },
    });
    res.status(201).json(versClient(creee));
  })
);

// DELETE /api/lieux/:id/illustrations-client/:iid — retire une photo du client
illustrationsEvenementRouter.delete(
  "/:id/illustrations-client/:iid",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = z.coerce.number().int().positive().parse(req.params.id);
    const iid = z.coerce.number().int().positive().parse(req.params.iid);
    const { count } = await prisma.illustrationLieu.deleteMany({ where: { id: iid, lieuId } });
    if (!count) throw new HttpError(404, "INTROUVABLE", "Photo introuvable");
    await toucherClient(lieuId);
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "illustration_lieu", entiteId: `${lieuId}:${iid}`, action: "SUPPRESSION" } });
    res.status(204).end();
  })
);

// POST …/illustrations/garder-pour-client — « Garder aussi pour le client » : copie les photos de l'événement
// (série des cadres) dans celles du client, dans la limite de la place restante
illustrationsEvenementRouter.post(
  chemins("/illustrations/garder-pour-client"),
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const e = await evenementEnregistre(lieuId, eid);
    const place = MAX_PAR_SERIE - (await prisma.illustrationLieu.count({ where: { lieuId } }));
    const photos = place > 0
      ? await prisma.illustrationEvenement.findMany({
          where: { configEvenementId: e.id, cible: "cadres" },
          select: { forme: true, largeur: true, hauteur: true, image: true, vignette: true },
          orderBy: { id: "asc" },
          take: place,
        })
      : [];
    if (photos.length) {
      await prisma.illustrationLieu.createMany({ data: photos.map((p) => ({ ...p, lieuId })) });
      await toucherClient(lieuId);
      await prisma.auditLog.create({
        data: { userId: req.utilisateur?.id ?? null, entite: "illustration_lieu", entiteId: String(lieuId), action: "CREATION", apres: { copieDe: e.id, nombre: photos.length } },
      });
    }
    res.json({ copiees: photos.length, place: Math.max(0, place) });
  })
);
