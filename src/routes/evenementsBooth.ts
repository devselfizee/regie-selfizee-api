import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { requirePerm } from "../middleware/permissions.js";
import { heureSchema, instantsDe } from "../config-evenement/reglages.js";
import { jourIso } from "../config-evenement/programmeBorne.js";

// Créneaux d'événements booth programmés sur un lieu (avenant de l'équipe borne du 18/11/2026) : dans l'onglet
// Configuration, à côté des événements Régie. La Régie ne vérifie pas le code auprès de booth (demande de
// l'exploitant) : seulement sa forme. Le programme de la borne (programmeBorne.ts) le transmet tel quel. Montée sous
// /api/lieux ; mêmes droits que les événements Régie.
export const evenementsBoothRouter = Router();
const voir = requirePerm("evenements.view");
const modifier = requirePerm("evenements.edit");

/** Code booth : 3 à 8 lettres ou chiffres, mis en majuscules (la borne compare en majuscules). */
const codeBooth = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,8}$/, "Code attendu : 3 à 8 lettres ou chiffres");
const saisieSchema = z.object({
  code: codeBooth,
  nom: z.string().trim().max(80).nullable().default(null).transform((n) => n || null),
  dateDebut: z.iso.date(),
  dateFin: z.iso.date(),
  heureDebut: heureSchema.nullable().default(null),
  heureFin: heureSchema.nullable().default(null),
});
function lireSaisie(corps: unknown) {
  const saisie = saisieSchema.parse(corps);
  const { debut, fin } = instantsDe(saisie);
  if (fin <= debut) throw new HttpError(400, "DATES", "La fin est avant le début.");
  return saisie;
}
/** Jour « AAAA-MM-JJ » → valeur d'une colonne @db.Date. */
const enDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

const selection = { id: true, code: true, nom: true, dateDebut: true, dateFin: true, heureDebut: true, heureFin: true, createdAt: true, updatedAt: true } as const;
type Ligne = { id: number; code: string; nom: string | null; dateDebut: Date; dateFin: Date; heureDebut: string | null; heureFin: string | null; createdAt: Date; updatedAt: Date };
const versJson = (e: Ligne) => ({
  id: e.id, code: e.code, nom: e.nom, origine: "booth" as const,
  dateDebut: jourIso(e.dateDebut), dateFin: jourIso(e.dateFin), heureDebut: e.heureDebut, heureFin: e.heureFin,
  creeLe: e.createdAt, modifieLe: e.updatedAt,
});

async function creneauDe(lieuId: number, bid: number) {
  const e = await prisma.evenementBooth.findFirst({ where: { id: bid, lieuId }, select: selection });
  if (!e) throw new HttpError(404, "INTROUVABLE", "Créneau booth introuvable");
  return e;
}

// GET /api/lieux/:id/evenements-booth — les créneaux du lieu, du plus récent au plus ancien
evenementsBoothRouter.get(
  "/:id/evenements-booth",
  voir,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const liste = await prisma.evenementBooth.findMany({ where: { lieuId }, select: selection, orderBy: [{ dateDebut: "desc" }, { id: "desc" }] });
    res.json(liste.map(versJson));
  })
);

// POST /api/lieux/:id/evenements-booth { code, nom?, dateDebut, dateFin, heureDebut?, heureFin? } — programme un code booth
evenementsBoothRouter.post(
  "/:id/evenements-booth",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    if (!(await prisma.lieu.findUnique({ where: { id: lieuId }, select: { id: true } }))) throw new HttpError(404, "INTROUVABLE");
    const s = lireSaisie(req.body);
    const e = await prisma.evenementBooth.create({
      data: { lieuId, code: s.code, nom: s.nom, dateDebut: enDate(s.dateDebut), dateFin: enDate(s.dateFin), heureDebut: s.heureDebut, heureFin: s.heureFin, creeParId: req.utilisateur?.id ?? null },
      select: selection,
    });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "evenement_booth", entiteId: String(e.id), action: "CREATION", apres: { lieuId, ...s } },
    });
    res.status(201).json(versJson(e));
  })
);

// PUT /api/lieux/:id/evenements-booth/:bid — modifie le code, le nom ou les dates
evenementsBoothRouter.put(
  "/:id/evenements-booth/:bid",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const avant = await creneauDe(lieuId, Number(req.params.bid));
    const s = lireSaisie(req.body);
    const e = await prisma.evenementBooth.update({
      where: { id: avant.id },
      data: { code: s.code, nom: s.nom, dateDebut: enDate(s.dateDebut), dateFin: enDate(s.dateFin), heureDebut: s.heureDebut, heureFin: s.heureFin },
      select: selection,
    });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "evenement_booth", entiteId: String(e.id), action: "MODIFICATION", avant: versJson(avant), apres: { lieuId, ...s } },
    });
    res.json(versJson(e));
  })
);

// DELETE /api/lieux/:id/evenements-booth/:bid — retire le créneau (la borne reviendra au programme au prochain appel)
evenementsBoothRouter.delete(
  "/:id/evenements-booth/:bid",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const e = await creneauDe(lieuId, Number(req.params.bid));
    await prisma.evenementBooth.delete({ where: { id: e.id } });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "evenement_booth", entiteId: String(e.id), action: "SUPPRESSION", avant: versJson(e) },
    });
    res.status(204).end();
  })
);
