import { Router } from "express";
import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import { asynchrone } from "../lib/http.js";
import { FUSEAU_METIER } from "../lib/temps.js";
import { perimetreLieux, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { lireJournal } from "../config-evenement/programmeBorne.js";

// Journal des téléchargements d'événements par les bornes (page « Téléchargements » de la Régie) : monté sous
// /api/telechargements-evenements, droit bornes.view. Lecture par curseur (avant=<id>), sans total : la table grossit
// vite, le coût d'une page ne doit pas dépendre de sa taille.
export const telechargementsEvenementsRouter = Router();

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const minuitParis = (ymd: string, plusJours = 0) => {
  const [a, m, j] = ymd.split("-").map(Number);
  return new Date(new TZDate(a, m - 1, j + plusJours, 0, 0, 0, FUSEAU_METIER).getTime());
};

const filtres = z.object({
  lieuId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  borneId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  parc: z.enum(["SELFIZEE", "CLIENT", "TEST"]).optional(),
  etat: z.enum(["DEMANDE", "ENVOYE", "TELECHARGE", "INSTALLE", "ECHEC"]).optional(),
  declencheur: z.enum(["AUTO", "MANUEL"]).optional(),
  du: z.string().regex(JOUR).optional(),
  au: z.string().regex(JOUR).optional(),
  avant: z.string().regex(/^\d{1,18}$/).optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

// GET /api/telechargements-evenements?lieuId=&borneId=&parc=&etat=&declencheur=&du=&au=&avant=&limite=
telechargementsEvenementsRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const f = filtres.parse(req.query);
    const p = perimetreLieux(req.utilisateur);
    // Périmètre et parc portent sur le lieu de l'événement : sans l'un ni l'autre, aucune jointure de filtre
    const lieu = p || (f.parc && !f.lieuId) ? { ...(f.parc && !f.lieuId ? { parc: f.parc } : {}), ...(p?.commercialId ? { commercialId: p.commercialId } : {}), ...(p?.lieuId ? { id: p.lieuId } : {}) } : undefined;
    res.json(
      await lireJournal({
        lieuId: f.lieuId,
        borneId: f.borneId,
        etat: f.etat,
        declencheur: f.declencheur,
        du: f.du ? minuitParis(f.du) : undefined,
        au: f.au ? minuitParis(f.au, 1) : undefined,
        avant: f.avant ? BigInt(f.avant) : undefined,
        limite: f.limite,
        lieu,
      })
    );
  })
);
