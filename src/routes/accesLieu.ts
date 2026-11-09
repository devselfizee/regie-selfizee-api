import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { requirePerm } from "../middleware/permissions.js";
import { preparerIllustration } from "../config-evenement/illustrations.js";
import { nettoyerTexteRiche } from "../lib/texteRiche.js";

// Accès au lieu (retour de Sébastien) : localisation des clés (texte et photos), disponibilité des contacts.
// Lecture : qui voit la fiche ; écriture : lieux.edit. Monté sous /api/lieux.
export const accesLieuRouter = Router();
const modifier = requirePerm("lieux.edit");
const MAX_PHOTOS = 12;
const enDataUrl = (b: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(b).toString("base64")}`;

// PATCH /api/lieux/:id/acces { localisationCles?, disponibiliteContacts? } — HTML simple, nettoyé
accesLieuRouter.patch(
  "/:id/acces",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const saisie = z
      .object({ localisationCles: z.string().max(50_000).nullable().optional(), disponibiliteContacts: z.string().max(50_000).nullable().optional() })
      .parse(req.body);
    const data: { localisationCles?: string | null; disponibiliteContacts?: string | null } = {};
    if (saisie.localisationCles !== undefined) data.localisationCles = nettoyerTexteRiche(saisie.localisationCles);
    if (saisie.disponibiliteContacts !== undefined) data.disponibiliteContacts = nettoyerTexteRiche(saisie.disponibiliteContacts);
    const l = await prisma.lieu.update({ where: { id: lieuId }, data, select: { localisationCles: true, disponibiliteContacts: true } });
    res.json(l);
  })
);

// GET /api/lieux/:id/photos-cles — vignettes
accesLieuRouter.get(
  "/:id/photos-cles",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const photos = await prisma.lieuPhotoCles.findMany({
      where: { lieuId },
      orderBy: { id: "asc" },
      select: { id: true, legende: true, largeur: true, hauteur: true, vignette: true, createdAt: true, creePar: { select: { prenom: true, nom: true } } },
    });
    res.json(photos.map((p) => ({ ...p, vignette: enDataUrl(p.vignette) })));
  })
);

// GET /api/lieux/:id/photos-cles/:pid — la photo en grand (data URL : l'écran l'ouvre avec le jeton)
accesLieuRouter.get(
  "/:id/photos-cles/:pid",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const p = await prisma.lieuPhotoCles.findFirst({ where: { id: Number(req.params.pid), lieuId }, select: { id: true, legende: true, image: true } });
    if (!p) throw new HttpError(404, "INTROUVABLE", "Photo introuvable");
    res.json({ id: p.id, legende: p.legende, image: enDataUrl(p.image) });
  })
);

// POST /api/lieux/:id/photos-cles { image (data URL), legende? } — réduite à 1200 px
accesLieuRouter.post(
  "/:id/photos-cles",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const saisie = z
      .object({
        image: z.string().regex(/^data:image\/(jpeg|png|webp|bmp);base64,[A-Za-z0-9+/=]+$/, "Image JPEG, PNG, WebP ou BMP attendue"),
        legende: z.string().trim().max(300).nullable().optional(),
      })
      .parse(req.body);
    if ((await prisma.lieuPhotoCles.count({ where: { lieuId } })) >= MAX_PHOTOS) {
      throw new HttpError(400, "TROP_DE_PHOTOS", `${MAX_PHOTOS} photos au plus : retirez-en une d'abord.`);
    }
    let p;
    try {
      p = await preparerIllustration(Buffer.from(saisie.image.slice(saisie.image.indexOf(",") + 1), "base64"));
    } catch {
      throw new HttpError(400, "IMAGE_ILLISIBLE", "Image illisible : JPEG, PNG, WebP ou BMP.");
    }
    const creee = await prisma.lieuPhotoCles.create({
      data: { lieuId, legende: saisie.legende || null, largeur: p.largeur, hauteur: p.hauteur, image: new Uint8Array(p.image), vignette: new Uint8Array(p.vignette), creeParId: req.utilisateur?.id ?? null },
      select: { id: true },
    });
    res.status(201).json(creee);
  })
);

// DELETE /api/lieux/:id/photos-cles/:pid
accesLieuRouter.delete(
  "/:id/photos-cles/:pid",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    await prisma.lieuPhotoCles.deleteMany({ where: { id: Number(req.params.pid), lieuId } });
    res.status(204).end();
  })
);
