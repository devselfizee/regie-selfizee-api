import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { cadreSchema, gabaritParam, verifierCadre } from "../config-evenement/cadres.js";

// Cadres de la fiche événement d'un lieu (CDC page souvenir § 13.2) : un cadre dessiné au studio
// par gabarit du kit coché. Réservé aux admins, monté sous /api/lieux comme la fiche événement.
export const cadresEvenementRouter = Router();
const admin = exiger("ADMIN");

// Sans le canvas ni le rendu : la liste ne sert qu'aux vignettes de l'écran Gabarits
const resume = { gabarit: true, nom: true, formatId: true, gabaritStudioId: true, nbPoses: true, vignette: true, updatedAt: true } as const;

async function lieuExiste(lieuId: number) {
  if (!(await prisma.lieu.findUnique({ where: { id: lieuId }, select: { id: true } }))) throw new HttpError(404, "INTROUVABLE");
}

// GET /api/lieux/:id/evenement/cadres — les cadres du lieu, sans leur contenu
cadresEvenementRouter.get(
  "/:id/evenement/cadres",
  admin,
  asynchrone(async (req, res) => {
    const lieuId = Number(req.params.id);
    await lieuExiste(lieuId);
    res.json(await prisma.cadreEvenement.findMany({ where: { lieuId }, select: resume, orderBy: { gabarit: "asc" } }));
  })
);

// GET /api/lieux/:id/evenement/cadres/:gabarit — le cadre à rouvrir dans le studio (canvas compris, sans le rendu)
cadresEvenementRouter.get(
  "/:id/evenement/cadres/:gabarit",
  admin,
  asynchrone(async (req, res) => {
    const lieuId = Number(req.params.id);
    const gabarit = gabaritParam.parse(req.params.gabarit);
    const cadre = await prisma.cadreEvenement.findUnique({
      where: { lieuId_gabarit: { lieuId, gabarit } },
      select: { ...resume, id: true, canvas: true },
    });
    if (!cadre) throw new HttpError(404, "INTROUVABLE", "Pas encore de cadre pour ce gabarit");
    res.json(cadre);
  })
);

// PUT /api/lieux/:id/evenement/cadres/:gabarit — crée ou remplace le cadre du gabarit
cadresEvenementRouter.put(
  "/:id/evenement/cadres/:gabarit",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    const gabarit = gabaritParam.parse(req.params.gabarit);
    const saisi = cadreSchema.parse(req.body);
    const refus = verifierCadre(gabarit, saisi);
    if (refus) throw new HttpError(400, "CADRE_INVALIDE", refus);
    await lieuExiste(lieuId);

    const donnees = { ...saisi, gabaritStudioId: saisi.gabaritStudioId ?? null, vignette: saisi.vignette ?? null };
    const existant = await prisma.cadreEvenement.findUnique({ where: { lieuId_gabarit: { lieuId, gabarit } }, select: { id: true } });
    const cadre = await prisma.cadreEvenement.upsert({
      where: { lieuId_gabarit: { lieuId, gabarit } },
      create: { lieuId, gabarit, ...donnees },
      update: donnees,
      select: { ...resume, id: true },
    });
    await prisma.auditLog.create({
      data: {
        userId: req.utilisateur?.id ?? null, entite: "cadre_evenement", entiteId: `${lieuId}:${gabarit}`, action: existant ? "MODIFICATION" : "CREATION",
        apres: { nom: saisi.nom, formatId: saisi.formatId, gabaritStudioId: saisi.gabaritStudioId ?? null, nbPoses: saisi.nbPoses },
      },
    });
    res.json(cadre);
  })
);

// DELETE /api/lieux/:id/evenement/cadres/:gabarit — retire le cadre (le gabarit retombe sur celui du kit)
cadresEvenementRouter.delete(
  "/:id/evenement/cadres/:gabarit",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    const gabarit = gabaritParam.parse(req.params.gabarit);
    await prisma.cadreEvenement.delete({ where: { lieuId_gabarit: { lieuId, gabarit } } });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "cadre_evenement", entiteId: `${lieuId}:${gabarit}`, action: "SUPPRESSION" },
    });
    res.status(204).end();
  })
);
