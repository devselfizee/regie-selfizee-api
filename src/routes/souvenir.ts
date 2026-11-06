import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import sharp from "sharp";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { cheminAbsolu, extensionDuChemin, lireFlux } from "../lib/stockage.js";
import { normaliserCode } from "../mes-photos/seances.js";
import { lireJeton, signatureValide } from "../souvenir/jeton.js";
import { COTE_WEB, jetonDuCodeSeance, lireSeanceSouvenir } from "../souvenir/seance.js";

// API de la page souvenir (projet souvenirs, myevent.selfizee.fr), montée sous /souvenir/v1.
// - Lecture d'une séance et résolution d'un code : appelées par le serveur de la page souvenir, jamais par le
//   navigateur, avec le secret partagé (en-tête X-Souvenir-Token = SOUVENIR_API_SECRET).
// - Fichiers (photos, GIF, photos d'exemple) : lus par le navigateur de l'invité, sur URL signée et expirante.

export const souvenirRouter = Router();

const EN_TETE = "x-souvenir-token";

function memeSecret(recu: string, attendu: string): boolean {
  const a = createHash("sha256").update(recu).digest();
  const b = createHash("sha256").update(attendu).digest();
  return timingSafeEqual(a, b);
}

/** Appel serveur à serveur de la page souvenir : 503 tant que le secret n'est pas configuré, 401 s'il est faux. */
function serveurSouvenir(req: Request, res: Response, next: NextFunction) {
  const attendu = process.env.SOUVENIR_API_SECRET;
  if (!attendu) return res.status(503).json({ error: "SOUVENIR_DESACTIVE" });
  const recu = req.headers[EN_TETE];
  if (typeof recu !== "string" || !recu || !memeSecret(recu, attendu)) return res.status(401).json({ error: "TOKEN_INVALIDE" });
  next();
}

/** Base absolue des URLs de fichiers : celle que le navigateur de l'invité peut joindre. */
const baseFichiers = (req: Request) => (process.env.SOUVENIR_URL_FICHIERS || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

// GET /souvenir/v1/seances/:token — la séance du jeton (événement, état, visuels) ; 404 si le jeton n'a pas de sens
souvenirRouter.get(
  "/seances/:token",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    const jeton = lireJeton(String(req.params.token));
    const seance = jeton ? await lireSeanceSouvenir(jeton, baseFichiers(req)) : null;
    if (!seance) throw new HttpError(404, "INTROUVABLE");
    res.setHeader("Cache-Control", "no-store");
    res.json(seance);
  })
);

// POST /souvenir/v1/code { code } — code de séance imprimé → { token } ; 404 si inconnu sur 90 jours
// (la limite d'essais par IP est tenue par la page souvenir, qui connaît l'IP de l'invité)
souvenirRouter.post(
  "/code",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    const { code } = z.object({ code: z.string().max(20) }).parse(req.body);
    const normalise = normaliserCode(code);
    const token = normalise ? await jetonDuCodeSeance(normalise) : null;
    if (!token) throw new HttpError(404, "CODE_INCONNU");
    res.json({ token });
  })
);

/** Refuse (404, sans détail) une URL de fichier mal signée ou expirée. */
function verifierSignature(req: Request) {
  if (!signatureValide(req.path, req.query.exp, req.query.sig)) throw new HttpError(404, "INTROUVABLE");
}

/** En-têtes communs des fichiers : cache privé jusqu'à l'expiration de l'URL, jamais indexés. */
function entetes(res: Response, type: string, exp: unknown) {
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", `private, max-age=${Math.max(0, Number(exp) - Math.floor(Date.now() / 1000))}`);
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("Referrer-Policy", "no-referrer");
}

const uuidSchema = z.uuid();

// GET /souvenir/v1/fichiers/:uuid?exp=&sig= — visuel d'une séance : photo réduite à 1600 px, GIF tel quel
souvenirRouter.get(
  "/fichiers/:uuid",
  asynchrone(async (req, res) => {
    verifierSignature(req);
    const uuid = uuidSchema.safeParse(req.params.uuid);
    const m = uuid.success ? await prisma.media.findUnique({ where: { uuid: uuid.data }, select: { mediaStatut: true, mediaChemin: true } }) : null;
    if (!m || m.mediaStatut !== "TELECHARGE" || !m.mediaChemin) throw new HttpError(404, "INTROUVABLE");
    if (extensionDuChemin(m.mediaChemin) === "gif") {
      entetes(res, "image/gif", req.query.exp);
      const flux = lireFlux(m.mediaChemin);
      flux.on("error", () => (res.headersSent ? res.destroy() : res.status(404).json({ error: "INTROUVABLE" })));
      flux.pipe(res);
      return;
    }
    let image: Buffer;
    try {
      image = await sharp(cheminAbsolu(m.mediaChemin)).rotate().resize(COTE_WEB, COTE_WEB, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    } catch {
      throw new HttpError(404, "INTROUVABLE");
    }
    entetes(res, "image/jpeg", req.query.exp);
    res.end(image);
  })
);

// GET /souvenir/v1/illustrations/:origine/:id?exp=&sig= — photo d'exemple de l'événement (e) ou d'une série (s)
souvenirRouter.get(
  "/illustrations/:origine/:id",
  asynchrone(async (req, res) => {
    verifierSignature(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new HttpError(404, "INTROUVABLE");
    const i =
      req.params.origine === "e"
        ? await prisma.illustrationEvenement.findUnique({ where: { id }, select: { image: true } })
        : req.params.origine === "s"
          ? await prisma.illustrationSerieImage.findUnique({ where: { id }, select: { image: true } })
          : null;
    if (!i) throw new HttpError(404, "INTROUVABLE");
    entetes(res, "image/jpeg", req.query.exp);
    res.end(Buffer.from(i.image));
  })
);
