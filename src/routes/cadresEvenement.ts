import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { cadreSchema, verifierCadre } from "../config-evenement/cadres.js";
import { reglagesSchema } from "../config-evenement/reglages.js";
import { chemins, cible, evenementDe, toucher } from "../config-evenement/acces.js";

// Cadres d'un événement de la borne (CDC page souvenir § 13.2) : un cadre dessiné au studio par composition
// de l'écran de choix (un même gabarit du kit peut revenir plusieurs fois : 8 polas…). Réservé aux admins,
// monté sous /api/lieux comme la fiche événement, pour l'événement habituel et les ponctuels.
export const cadresEvenementRouter = Router();
const admin = exiger("ADMIN");

// Sans le canvas ni le rendu : la liste ne sert qu'aux vignettes de l'écran Gabarits
const resume = { compositionId: true, gabarit: true, nom: true, formatId: true, gabaritStudioId: true, nbPoses: true, vignette: true, updatedAt: true } as const;
const compositionParam = z.string().regex(/^[a-z0-9-]{1,40}$/);

/** L'événement enregistré visé ; un cadre n'existe pas sans lui (le code et les réglages viennent avec). */
async function evenementEnregistre(lieuId: number, eid: number | null) {
  const e = await evenementDe(lieuId, eid);
  if (!e) throw new HttpError(400, "PAS_ENCORE_ENREGISTRE", "Enregistrez d'abord la fiche événement");
  return e;
}

// GET …/cadres — les cadres de l'événement, sans leur contenu
cadresEvenementRouter.get(
  chemins("/cadres"),
  admin,
  asynchrone(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const e = await evenementDe(lieuId, eid);
    res.json(e ? await prisma.cadreEvenement.findMany({ where: { configEvenementId: e.id }, select: resume, orderBy: { id: "asc" } }) : []);
  })
);

// GET …/cadres/:composition — le cadre à rouvrir dans le studio (canvas compris, sans le rendu)
cadresEvenementRouter.get(
  chemins("/cadres/:composition"),
  admin,
  asynchrone(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const compositionId = compositionParam.parse(req.params.composition);
    const e = await evenementDe(lieuId, eid);
    const cadre = e
      ? await prisma.cadreEvenement.findUnique({
          where: { configEvenementId_compositionId: { configEvenementId: e.id, compositionId } },
          select: { ...resume, id: true, canvas: true },
        })
      : null;
    if (!cadre) throw new HttpError(404, "INTROUVABLE", "Pas encore de cadre pour cette composition");
    res.json(cadre);
  })
);

// PUT …/cadres/:composition — crée ou remplace le cadre d'une composition de l'événement
cadresEvenementRouter.put(
  chemins("/cadres/:composition"),
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const compositionId = compositionParam.parse(req.params.composition);
    const saisi = cadreSchema.parse(req.body);
    const e = await evenementEnregistre(lieuId, eid);
    const composition = reglagesSchema.parse(e.reglages).gabarits.choisis.find((c) => c.id === compositionId);
    if (!composition) throw new HttpError(404, "INTROUVABLE", "Cette composition n'est pas (ou plus) dans l'événement : enregistrez la fiche.");
    const refus = verifierCadre(composition.gabarit, saisi);
    if (refus) throw new HttpError(400, "CADRE_INVALIDE", refus);

    const cle = { configEvenementId_compositionId: { configEvenementId: e.id, compositionId } };
    const donnees = { ...saisi, gabarit: composition.gabarit, gabaritStudioId: saisi.gabaritStudioId ?? null, vignette: saisi.vignette ?? null };
    const existant = await prisma.cadreEvenement.findUnique({ where: cle, select: { id: true } });
    const cadre = await prisma.cadreEvenement.upsert({
      where: cle,
      create: { lieuId, configEvenementId: e.id, compositionId, ...donnees },
      update: donnees,
      select: { ...resume, id: true },
    });
    await toucher(e.id);
    await prisma.auditLog.create({
      data: {
        userId: req.utilisateur?.id ?? null, entite: "cadre_evenement", entiteId: `${e.id}:${compositionId}`, action: existant ? "MODIFICATION" : "CREATION",
        apres: { nom: saisi.nom, gabarit: composition.gabarit, formatId: saisi.formatId, gabaritStudioId: saisi.gabaritStudioId ?? null, nbPoses: saisi.nbPoses },
      },
    });
    res.json(cadre);
  })
);

// DELETE …/cadres/:composition — retire le cadre (la composition retombe sur celui du kit)
cadresEvenementRouter.delete(
  chemins("/cadres/:composition"),
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const compositionId = compositionParam.parse(req.params.composition);
    const e = await evenementEnregistre(lieuId, eid);
    await prisma.cadreEvenement.delete({ where: { configEvenementId_compositionId: { configEvenementId: e.id, compositionId } } });
    await toucher(e.id);
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "cadre_evenement", entiteId: `${e.id}:${compositionId}`, action: "SUPPRESSION" },
    });
    res.status(204).end();
  })
);
