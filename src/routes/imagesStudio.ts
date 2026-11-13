import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import sharp from "sharp";
import { z } from "zod";
import { asynchrone, HttpError } from "../lib/http.js";
import { cheminAbsolu, ecrireBuffer, existe } from "../lib/stockage.js";
import { requirePerm } from "../middleware/permissions.js";

// Images du studio de cadres (importées, générées par l'IA, fonds…) : comme le backend de l'éditeur de
// selfizee-booth-ui (POST /api/uploads/image), elles sont enregistrées en fichiers au lieu de rester en base64 dans le
// dessin du cadre. Rangées dans le volume des médias (MEDIAS_DIR/studio/), nommées par leur empreinte SHA-256 : la même
// image n'est stockée qu'une fois, et un nom ne se devine pas. Ce sont des éléments de décor, pas des données
// personnelles : servies sans jeton (le studio les charge par une balise img), avec un cache long (le contenu d'un nom
// ne change jamais).

/** Monté sous /api/studio/images (connexion) */
export const imagesStudioRouter = Router();
/** Monté sous /studio/v1/images (public) */
export const imagesStudioPublicRouter = Router();

const FORMATS: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp", gif: "gif" };
const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i;
const MAX_OCTETS = 15 * 1024 * 1024;
const NOM = /^[0-9a-f]{64}\.(jpg|png|webp|gif)$/;

const cheminImage = (nom: string) => `studio/${nom}`;
/** Adresse publique de l'API vue par le navigateur (derrière le proxy : trust proxy) */
const origine = (req: Request) => `${req.protocol}://${req.get("host")}`;

// POST /api/studio/images { dataUrl } → { url } : l'image enregistrée, à mettre dans le dessin du cadre
imagesStudioRouter.post(
  "/",
  requirePerm("evenements.edit"),
  asynchrone(async (req, res) => {
    const { dataUrl } = z.object({ dataUrl: z.string().max(Math.ceil((MAX_OCTETS * 4) / 3) + 100) }).parse(req.body);
    const m = DATA_URL.exec(dataUrl);
    if (!m) throw new HttpError(400, "IMAGE_INVALIDE", "Image attendue en data URL (base64).");
    const contenu = Buffer.from(m[1], "base64");
    if (!contenu.length || contenu.length > MAX_OCTETS) throw new HttpError(413, "IMAGE_TROP_GROSSE", "Image de 15 Mo au plus.");
    // Le format vient du fichier lui-même, pas de l'en-tête de la data URL
    const meta = await sharp(contenu, { animated: true }).metadata().catch(() => null);
    const extension = meta?.format ? FORMATS[meta.format] : undefined;
    if (!extension) throw new HttpError(400, "IMAGE_INVALIDE", "Format accepté : JPEG, PNG, WebP ou GIF.");
    const nom = `${createHash("sha256").update(contenu).digest("hex")}.${extension}`;
    if (!(await existe(cheminImage(nom)))) await ecrireBuffer(cheminImage(nom), contenu);
    res.status(201).json({ url: `${origine(req)}/studio/v1/images/${nom}`, largeur: meta?.width ?? null, hauteur: meta?.pageHeight ?? meta?.height ?? null });
  })
);

// GET /studio/v1/images/:nom — l'image, sans jeton (CORS ouvert : le studio la charge en crossOrigin « anonymous »)
imagesStudioPublicRouter.get("/:nom", (req, res) => {
  const nom = req.params.nom;
  if (!NOM.test(nom)) return res.status(404).end();
  res.sendFile(
    cheminAbsolu(cheminImage(nom)),
    { headers: { "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } },
    (err) => {
      if (err && !res.headersSent) res.status(404).end();
    }
  );
});
