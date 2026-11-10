import { Router } from "express";
import { asynchrone, HttpError } from "../lib/http.js";
import { verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { lireFiltres, type Filtres } from "../stats/filtres.js";
import { statsFicheLieu } from "../stats/ficheLieuStats.js";

// Onglet Statistiques de la fiche lieu : soirées × heures, comparaison aux lieux du même type,
// période précédente comparable ou non. Monté sous /api/stats/fiche-lieu avec requirePerm("ventes.view").
export const ficheLieuStatsRouter = Router();

// GET /api/stats/fiche-lieu/:id?du=&au=&gammeId=&typeModuleId=&moyenPaiement=
ficheLieuStatsRouter.get(
  "/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    if (!Number.isInteger(lieuId) || lieuId <= 0) throw new HttpError(404, "INTROUVABLE");
    await verifierAccesLieu(req.utilisateur, lieuId);
    const f: Filtres = { ...lireFiltres(req.query), lieuId: [lieuId] };
    res.json(await statsFicheLieu(lieuId, f));
  })
);
