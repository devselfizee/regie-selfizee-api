import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { chemins, cible, evenementDe, toucher } from "../config-evenement/acces.js";
import { CIBLES, MAX_PAR_SERIE, preparerIllustration } from "../config-evenement/illustrations.js";

// Photos d'exemple d'un événement (illustrations des cases des cadres, kit nightlife) : série des cadres
// (page de choix du format) et série de l'accueil. Réservé aux admins, monté sous /api/lieux comme la
// fiche événement, pour l'événement habituel et les ponctuels. Copiées dans le zip (zip.ts).
export const illustrationsEvenementRouter = Router();
const admin = exiger("ADMIN");

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
  admin,
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
  admin,
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
  admin,
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
