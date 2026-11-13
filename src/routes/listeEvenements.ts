import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";

// Liste de tous les événements de borne (codes R…), tous lieux confondus : super admins seulement (demande du 13/11).
// Avec les médias reçus de PikCloud pour chacun, et les codes reçus de PikCloud qu'aucun événement ne porte.
export const listeEvenementsRouter = Router();

type DatesLieu = { dateDebut?: string; dateFin?: string; heureDebut?: string | null; heureFin?: string | null };

// GET /api/config-evenements
listeEvenementsRouter.get(
  "/",
  asynchrone(async (_req, res) => {
    const [evenements, medias, inconnus] = await Promise.all([
      prisma.configEvenement.findMany({
        where: { lieu: { supprimeLe: null } },
        select: {
          id: true, habituel: true, nom: true, code: true, reglages: true, version: true, publieeLe: true, updatedAt: true, createdAt: true,
          lieu: { select: { id: true, enseigne: true, ville: true, parc: true, demo: true } },
        },
      }),
      prisma.media.groupBy({ by: ["configEvenementId"], where: { configEvenementId: { not: null } }, _count: { _all: true }, _max: { createdAt: true } }),
      // Médias arrivés avec un code d'événement inconnu de la Régie (rattachés dès qu'un renvoi suit la création de l'événement)
      prisma.media.groupBy({ by: ["codeEvent"], where: { configEvenementId: null }, _count: { _all: true }, _max: { createdAt: true } }),
    ]);
    const parEvenement = new Map(medias.map((m) => [m.configEvenementId!, { nombre: m._count._all, dernier: m._max.createdAt }]));
    // Médias téléchargés (photo visible dans la Régie), par événement
    const telecharges = new Map(
      (await prisma.media.groupBy({ by: ["configEvenementId"], where: { configEvenementId: { not: null }, mediaStatut: "TELECHARGE" }, _count: { _all: true } })).map((m) => [m.configEvenementId!, m._count._all])
    );

    res.json({
      evenements: evenements
        .map((e) => {
          const dates = ((e.reglages as { lieu?: DatesLieu } | null)?.lieu ?? {}) as DatesLieu;
          const m = parEvenement.get(e.id);
          return {
            id: e.id,
            lieu: e.lieu,
            habituel: e.habituel,
            nom: e.nom,
            code: e.code,
            // Programmation d'un événement ponctuel (l'habituel couvre tout le reste du temps)
            dateDebut: e.habituel ? null : (dates.dateDebut ?? null),
            dateFin: e.habituel ? null : (dates.dateFin ?? null),
            version: e.version,
            publieeLe: e.publieeLe,
            modifieDepuisPublication: e.publieeLe === null || e.updatedAt > e.publieeLe,
            creeLe: e.createdAt,
            medias: { recus: m?.nombre ?? 0, telecharges: telecharges.get(e.id) ?? 0, dernier: m?.dernier ?? null },
          };
        })
        .sort((a, b) => a.lieu.enseigne.localeCompare(b.lieu.enseigne, "fr") || Number(b.habituel) - Number(a.habituel) || (b.dateDebut ?? "").localeCompare(a.dateDebut ?? "")),
      codesInconnus: inconnus
        .map((c) => ({ code: c.codeEvent, medias: c._count._all, dernier: c._max.createdAt }))
        .sort((a, b) => (b.dernier?.getTime() ?? 0) - (a.dernier?.getTime() ?? 0)),
    });
  })
);
