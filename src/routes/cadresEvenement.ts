import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { type UtilisateurRequest } from "../middleware/utilisateur.js";
import { cadreSchema, verifierCadre } from "../config-evenement/cadres.js";
import { reglagesSchema } from "../config-evenement/reglages.js";
import { chemins, cible, evenementDe, toucher } from "../config-evenement/acces.js";
import { requirePerm } from "../middleware/permissions.js";

// Cadres d'un événement de la borne (CDC page souvenir § 13.2) : un cadre dessiné au studio par composition
// de l'écran de choix (un même gabarit du kit peut revenir plusieurs fois : 8 polas…). Réservé aux admins,
// monté sous /api/lieux comme la fiche événement, pour l'événement habituel et les ponctuels.
export const cadresEvenementRouter = Router();
const voir = requirePerm("evenements.view");
const modifier = requirePerm("evenements.edit");

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
  voir,
  asynchrone(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const e = await evenementDe(lieuId, eid);
    res.json(e ? await prisma.cadreEvenement.findMany({ where: { configEvenementId: e.id }, select: resume, orderBy: { id: "asc" } }) : []);
  })
);

// GET /api/lieux/:id/cadres-du-lieu?gabarit= — les cadres de tous les événements du lieu (par défaut et
// personnalisés), sans leur contenu : le départ « Cadre du lieu » du studio, pour repartir d'un cadre existant.
// Le contenu se lit ensuite sur la route du cadre (…/cadres/:composition de son événement).
cadresEvenementRouter.get(
  "/:id/cadres-du-lieu",
  voir,
  asynchrone(async (req, res) => {
    const lieuId = Number(req.params.id);
    if (!Number.isInteger(lieuId)) throw new HttpError(404, "INTROUVABLE");
    const gabarit = z.string().max(20).optional().parse(req.query.gabarit || undefined);
    const cadres = await prisma.cadreEvenement.findMany({
      where: { lieuId, ...(gabarit ? { gabarit } : {}) },
      select: { ...resume, evenement: { select: { id: true, nom: true, habituel: true, code: true } } },
      orderBy: { updatedAt: "desc" },
    });
    // Le par défaut d'abord, puis les événements personnalisés, chacun avec ses cadres du plus récent au plus ancien
    res.json(cadres.sort((a, b) => Number(b.evenement.habituel) - Number(a.evenement.habituel)));
  })
);

// GET …/cadres/:composition — le cadre à rouvrir dans le studio (canvas compris, sans le rendu)
cadresEvenementRouter.get(
  chemins("/cadres/:composition"),
  voir,
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
  modifier,
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

// POST …/cadres/:composition/dupliquer { vers } — copie le cadre (canvas, rendu, vignette) vers une autre
// composition du même gabarit, déjà enregistrée dans l'événement : « Dupliquer » de la fiche, pour un cadre
// voisin qui ne change que par quelques détails. Remplace le cadre de la cible s'il y en a un.
cadresEvenementRouter.post(
  chemins("/cadres/:composition/dupliquer"),
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const source = compositionParam.parse(req.params.composition);
    const { vers } = z.object({ vers: compositionParam }).parse(req.body);
    if (vers === source) throw new HttpError(400, "CADRE_INVALIDE", "La copie doit aller vers une autre composition");
    const e = await evenementEnregistre(lieuId, eid);
    const composition = reglagesSchema.parse(e.reglages).gabarits.choisis.find((c) => c.id === vers);
    if (!composition) throw new HttpError(404, "INTROUVABLE", "La composition de destination n'est pas dans l'événement : enregistrez la fiche.");
    const original = await prisma.cadreEvenement.findUnique({ where: { configEvenementId_compositionId: { configEvenementId: e.id, compositionId: source } } });
    if (!original) throw new HttpError(404, "INTROUVABLE", "Pas de cadre à dupliquer pour cette composition");
    if (original.gabarit !== composition.gabarit) throw new HttpError(400, "CADRE_INVALIDE", "Un cadre ne se duplique que vers le même gabarit du kit");

    const { nom, formatId, gabaritStudioId, nbPoses, canvas, image, vignette, gabarit } = original;
    const donnees = { nom, formatId, gabaritStudioId, nbPoses, canvas, image, vignette, gabarit };
    const cadre = await prisma.cadreEvenement.upsert({
      where: { configEvenementId_compositionId: { configEvenementId: e.id, compositionId: vers } },
      create: { lieuId, configEvenementId: e.id, compositionId: vers, ...donnees },
      update: donnees,
      select: resume,
    });
    await toucher(e.id);
    await prisma.auditLog.create({
      data: {
        userId: req.utilisateur?.id ?? null, entite: "cadre_evenement", entiteId: `${e.id}:${vers}`, action: "CREATION",
        apres: { copieDe: source, nom, gabarit, formatId, gabaritStudioId, nbPoses },
      },
    });
    res.status(201).json(cadre);
  })
);

// DELETE …/cadres/:composition — retire le cadre (la composition retombe sur celui du kit)
cadresEvenementRouter.delete(
  chemins("/cadres/:composition"),
  modifier,
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
