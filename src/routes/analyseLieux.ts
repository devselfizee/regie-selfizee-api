import { Router } from "express";
import { asynchrone } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { analyseLieux } from "../stats/analyseLieux.js";
import { filtresAutorises } from "./stats.js";

// Analyse du parc (page Lieux, onglet « Analyse ») ; monté sous /api/stats/lieux-analyse avec ventes.view
export const analyseLieuxRouter = Router();

// GET /api/stats/lieux-analyse?du=&au=&parc=&<filtres> — classement, matrice, critères, départements, lieux à surveiller
analyseLieuxRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    res.json(await analyseLieux(filtresAutorises(req)));
  })
);
