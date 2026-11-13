import { Router, type Response } from "express";
import { z } from "zod";
import { asynchrone, HttpError } from "../lib/http.js";
import { Limiteur } from "../lib/limiteur.js";
import { baseFichiers } from "../souvenir/base.js";
import { jetonConfigure, lireJetonAcces } from "../rgpd/jeton.js";
import { envoyerLienAcces, exporterCsv, modifierEnregistrement, rapport, supprimerEnregistrement, supprimerEvenement } from "../rgpd/donnees.js";

// API publique de la plateforme RGPD (rgpd.orkessi.com), montée sous /rgpd/v1 : même contrat que l'API RGPD du booth
// (/api/rgpd/informations|inscription|suppression|edition), sans connexion. L'accès aux données est protégé par le
// jeton chiffré du lien envoyé par mail (7 jours) ; la demande du lien répond pareil, adresse connue ou non.

export const rgpdRouter = Router();

const MINUTE = 60_000;
const lectures = new Limiteur(60, 10 * MINUTE); // lecture et export : 60 / 10 min / IP
const ecritures = new Limiteur(60, 10 * MINUTE); // suppressions et modifications : 60 / 10 min / IP
const demandesParIp = new Limiteur(20, 60 * MINUTE); // demandes de lien : 20 / heure / IP
const demandesParAdresse = new Limiteur(3, 60 * MINUTE); // 3 / heure / adresse, au-delà rien ne part

const TROP = "Trop de demandes. Réessayez dans quelques minutes.";

// Données personnelles : jamais en cache, jamais indexées
rgpdRouter.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
  if (!jetonConfigure()) return res.status(503).json({ error: "RGPD_INDISPONIBLE", message: "La plateforme RGPD n'est pas configurée (RGPD_SECRET)." });
  next();
});

const limiter = (l: Limiteur, ip: string | undefined) => {
  if (!l.essayer(ip ?? "?")) throw new HttpError(429, "TROP_DE_DEMANDES", TROP);
};

/** L'adresse d'un jeton valide et non expiré (écritures) ; 403 sinon, comme le booth. */
function adresseDuJeton(jeton: unknown): string {
  const j = lireJetonAcces(jeton);
  if (!j || j.expire) throw new HttpError(403, "LIEN_EXPIRE", "Ce lien a expiré. Refaites une demande pour en recevoir un nouveau.");
  return j.email;
}

const vide = (res: Response, expired: boolean) => res.json({ email: "", expired, mediaCount: 0, eventCount: 0, events: [] });

// GET /rgpd/v1/informations/:jeton → UserDataReport ({ expired: true } passé 7 jours ; 404 si le jeton est faux)
rgpdRouter.get(
  "/informations/:jeton",
  asynchrone(async (req, res) => {
    limiter(lectures, req.ip);
    const j = lireJetonAcces(req.params.jeton);
    if (!j) throw new HttpError(404, "LIEN_INVALIDE", "Ce lien n'est pas valide.");
    if (j.expire) return vide(res, true);
    res.json(await rapport(j.email, baseFichiers(req, false)));
  })
);

// GET /rgpd/v1/export/:jeton → CSV des données (droit à la portabilité)
rgpdRouter.get(
  "/export/:jeton",
  asynchrone(async (req, res) => {
    limiter(lectures, req.ip);
    const email = adresseDuJeton(req.params.jeton);
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="mes-donnees-selfizee.csv"' });
    res.send(await exporterCsv(email));
  })
);

// POST /rgpd/v1/inscription { email } → toujours { error: false } (adresse connue ou non) ; le mail part en arrière-plan
rgpdRouter.post(
  "/inscription",
  asynchrone(async (req, res) => {
    limiter(demandesParIp, req.ip);
    // Adresse souvent collée avec des espaces : nettoyée avant d'être validée
    const { email } = z.object({ email: z.string().max(220).transform((v) => v.trim().toLowerCase()).pipe(z.email().max(200)) }).parse(req.body);
    if (demandesParAdresse.essayer(email)) {
      envoyerLienAcces(email).then(
        (e) => e && console.error("Lien d'accès RGPD :", e),
        (err) => console.error("Lien d'accès RGPD :", err)
      );
    }
    res.json({ error: false });
  })
);

const jeton = z.string().max(600);

// POST /rgpd/v1/suppression { token, photoId, target? } ou { token, eventId } → { error: false, deleted, photoKept }
rgpdRouter.post(
  "/suppression",
  asynchrone(async (req, res) => {
    limiter(ecritures, req.ip);
    const b = z
      .object({ token: jeton, photoId: z.string().max(40).optional(), eventId: z.string().max(10).optional(), target: z.enum(["photo", "data", "both"]).optional() })
      .parse(req.body);
    const email = adresseDuJeton(b.token);
    if (b.photoId) return res.json({ error: false, ...(await supprimerEnregistrement(email, b.photoId, b.target ?? "both")) });
    if (b.eventId) return res.json({ error: false, ...(await supprimerEvenement(email, b.eventId)) });
    throw new HttpError(400, "CIBLE_MANQUANTE", "Rien à supprimer.");
  })
);

// POST /rgpd/v1/edition { token, photoId, fields: [{ contactId, value }] } → { error: false, updated }
rgpdRouter.post(
  "/edition",
  asynchrone(async (req, res) => {
    limiter(ecritures, req.ip);
    const b = z
      .object({
        token: jeton,
        photoId: z.string().max(40),
        fields: z.array(z.object({ contactId: z.string().max(30), value: z.string().max(200) })).min(1).max(10),
      })
      .parse(req.body);
    const email = adresseDuJeton(b.token);
    res.json({ error: false, updated: await modifierEnregistrement(email, b.photoId, b.fields) });
  })
);
