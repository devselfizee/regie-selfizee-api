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
import {
  demanderLien, EVENEMENTS_JOURNAL, gratter, inscription, inscrire, journaliserDepuisPage, mesSeances, RefusSouvenir, renvoyer, reveler,
} from "../souvenir/donnees.js";

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

// ─── Ce que l'invité écrit (CDC § 4.2 à 4.8) : appels du serveur de la page souvenir, avec le secret ───

/** Le jeton de la route, ou 404. */
function jetonDe(req: Request) {
  const j = lireJeton(String(req.params.token));
  if (!j) throw new HttpError(404, "INTROUVABLE");
  return j;
}
const idInscription = (req: Request) => {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, "INTROUVABLE");
  return id.data;
};
/** Refus métier (limite, page expirée…) : 422 avec le message à montrer à l'invité. */
const refus = (e: unknown) => {
  if (e instanceof RefusSouvenir) throw new HttpError(422, "REFUS", e.message);
  throw e;
};

const inscriptionSchema = z.object({
  email: z.email().max(200).transform((v) => v.trim().toLowerCase()),
  prenom: z.string().trim().max(60).optional(),
  estMoi: z.literal(true),
  optinLieu: z.boolean(),
  optinSelfizee: z.boolean(),
  textes: z.array(z.string().max(300)).min(1).max(5),
  ip: z.string().max(64),
  userAgent: z.string().max(1000).default(""),
});

// POST /souvenir/v1/seances/:token/inscriptions — « Recevoir mes photos » ; même adresse : renvoi du mail
souvenirRouter.post(
  "/seances/:token/inscriptions",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    const j = jetonDe(req);
    const d = inscriptionSchema.parse(req.body);
    res.status(201).json(await inscrire(j, d).catch(refus));
  })
);

// GET /souvenir/v1/seances/:token/inscriptions/:id — l'inscription (envois, carte) ; la livraison différée part si la photo est arrivée
souvenirRouter.get(
  "/seances/:token/inscriptions/:id",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    const i = await inscription(jetonDe(req), idInscription(req));
    if (!i) throw new HttpError(404, "INTROUVABLE");
    res.setHeader("Cache-Control", "no-store");
    res.json(i);
  })
);

// POST /souvenir/v1/seances/:token/inscriptions/:id/renvoi — « Renvoyer » (3 par heure)
souvenirRouter.post(
  "/seances/:token/inscriptions/:id/renvoi",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    await renvoyer(jetonDe(req), idInscription(req)).catch(refus);
    res.status(204).end();
  })
);

// POST /souvenir/v1/seances/:token/inscriptions/:id/carte — tire la carte à gratter (idempotent)
souvenirRouter.post(
  "/seances/:token/inscriptions/:id/carte",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    res.json(await gratter(jetonDe(req), idInscription(req)).catch(refus));
  })
);

// POST /souvenir/v1/seances/:token/inscriptions/:id/revelation — la carte a été grattée
souvenirRouter.post(
  "/seances/:token/inscriptions/:id/revelation",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    await reveler(jetonDe(req), idInscription(req));
    res.status(204).end();
  })
);

// POST /souvenir/v1/liens { email } — lien « Toutes tes photos » ; toujours 202 (adresse connue ou non). Le lien part
// par le mail 3 (fournisseur pas encore branché) ; en recette (SOUVENIR_SEANCES_TEST=1), il est rendu au serveur de la page.
souvenirRouter.post(
  "/liens",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    const { email } = z.object({ email: z.email().max(200).transform((v) => v.trim().toLowerCase()) }).parse(req.body);
    const lien = await demanderLien(email);
    res.status(202).json(lien && process.env.SOUVENIR_SEANCES_TEST === "1" ? { recette: lien } : {});
  })
);

// GET /souvenir/v1/liens/:jeton — l'adresse et les jetons des séances qui lui ont été livrées ; 404 si expiré ou déjà consommé
souvenirRouter.get(
  "/liens/:jeton",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    const jeton = String(req.params.jeton);
    const r = /^[A-Za-z0-9_-]{20,80}$/.test(jeton) ? await mesSeances(jeton) : null;
    if (!r) throw new HttpError(404, "INTROUVABLE");
    res.setHeader("Cache-Control", "no-store");
    res.json(r);
  })
);

// POST /souvenir/v1/journal { evenement, token?, details? } — compteur de la page (scan, gestes), sans donnée personnelle
souvenirRouter.post(
  "/journal",
  serveurSouvenir,
  asynchrone(async (req, res) => {
    const b = z.object({ evenement: z.enum(EVENEMENTS_JOURNAL), token: z.string().max(80).nullish(), details: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    const j = b.token ? lireJeton(b.token) : null;
    if (!b.token || j) await journaliserDepuisPage(b.evenement, j, b.details);
    res.status(204).end();
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
