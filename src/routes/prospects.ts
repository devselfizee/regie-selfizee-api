import { Router } from "express";
import { asynchrone, HttpError } from "../lib/http.js";
import { perimetreLieux, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { scorerProspects } from "../prospects/service.js";

// Score de potentiel des lieux prospectés (CDC V3)
export const prospectsRouter = Router();

/** Le commercial ne voit que ses prospects, et les lieux voisins qui ne sont pas à lui sont anonymisés. */
function perimetre(req: UtilisateurRequest) {
  const p = perimetreLieux(req.utilisateur);
  return {
    commercialId: p?.commercialId,
    visible: (l: { commercialId: number | null }) => !p || l.commercialId === p.commercialId,
  };
}

// GET /api/prospects — prospects classés par CA par jour estimé
prospectsRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    res.json(await scorerProspects(perimetre(req)));
  })
);

// GET /api/prospects/:id — détail : lieux semblables retenus, fiche à compléter
prospectsRouter.get(
  "/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, id);
    const r = await scorerProspects({ ...perimetre(req), ids: [id] });
    if (!r.prospects.length) throw new HttpError(404, "INTROUVABLE", "Ce lieu n'est pas un prospect");
    res.json({ references: r.references, precision: r.precision, ...r.prospects[0] });
  })
);
