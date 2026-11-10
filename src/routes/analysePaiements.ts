import { Router } from "express";
import { z } from "zod";
import { asynchrone } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { ymd } from "../stats/filtres.js";
import { analysePaiements } from "../stats/analysePaiements.js";
import { filtresAutorises } from "./stats.js";

// Analyse des paiements (page Paiements, onglet Analyse). Monté avec la permission de la page Paiements.
export const analysePaiementsRouter = Router();

const borne = z.coerce.number().int().positive().optional();

// GET /api/stats/paiements-analyse?du=&au=&borneId=&<filtres>
analysePaiementsRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    // Filtres restreints au périmètre de l'utilisateur (ses lieux pour un commercial)
    const f = filtresAutorises(req);
    const borneId = borne.parse(req.query.borneId);
    res.json({ periode: { du: ymd(f.du), au: ymd(f.au) }, ...(await analysePaiements(f, borneId)) });
  })
);
