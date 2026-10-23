import { Router } from "express";
import { z } from "zod";
import { asynchrone, HttpError } from "../lib/http.js";
import { Limiteur } from "../lib/limiteur.js";
import { demanderLienToutesMesPhotos, normaliserCode, pageSouvenirDuCode, simulation } from "../mes-photos/seances.js";

// Routes publiques de la page « Mes photos » (sans connexion) : montées sous /public/v1/mes-photos.
// Elles ne renvoient jamais de liste ni de donnée de la Régie (CDC page souvenir § 3 et § 4.7).
export const mesPhotosRouter = Router();

const MINUTE = 60_000;
const essaisCode = new Limiteur(10, 10 * MINUTE); // 10 essais / 10 min / IP
const liensParIp = new Limiteur(20, 60 * MINUTE); // 20 demandes / IP / heure
const liensParAdresse = new Limiteur(3, 60 * MINUTE); // 3 demandes / adresse / heure

const TROP = "Trop d'essais. Réessaie dans quelques minutes.";

// POST /public/v1/mes-photos/code { code } → { url } de la page souvenir, ou 404 (message unique)
mesPhotosRouter.post(
  "/code",
  asynchrone(async (req, res) => {
    if (!essaisCode.essayer(req.ip ?? "?")) throw new HttpError(429, "TROP_D_ESSAIS", TROP);
    const { code } = z.object({ code: z.string().max(20) }).parse(req.body);
    const normalise = normaliserCode(code);
    const url = normalise ? await pageSouvenirDuCode(normalise) : null;
    if (!url) throw new HttpError(404, "CODE_INCONNU", "On ne trouve pas ce code. Vérifie les six caractères.");
    res.json({ url, simulation: simulation() });
  })
);

// POST /public/v1/mes-photos/lien { email } → toujours la même réponse, adresse connue ou non
mesPhotosRouter.post(
  "/lien",
  asynchrone(async (req, res) => {
    if (!liensParIp.essayer(req.ip ?? "?")) throw new HttpError(429, "TROP_D_ESSAIS", TROP);
    const { email } = z.object({ email: z.email().max(200) }).parse(req.body);
    const adresse = email.trim().toLowerCase();
    // Au-delà de 3 demandes par heure pour une adresse : même réponse, mais plus rien n'est envoyé
    if (liensParAdresse.essayer(adresse)) await demanderLienToutesMesPhotos(adresse);
    res.status(202).json({ simulation: simulation() });
  })
);
