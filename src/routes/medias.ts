import { Router } from "express";
import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { EXTENSIONS_VIDEO, extensionDuChemin, lireBuffer, lireFlux, mimeDe } from "../lib/stockage.js";
import { FUSEAU_METIER } from "../lib/temps.js";
import { declencherTelechargement } from "../synchro-pikcloud/telechargement.js";
import { QR_BASE_URL } from "../config-evenement/generation.js";

// Galerie des médias reçus de PikCloud (docs/synchronisation-pikcloud.md) : les photos et vidéos des séances
// d'un lieu, par événement. Ce sont des photos de personnes : admin, commercial sur ses lieux, partenaire sur
// son lieu ; jamais servies en statique, toujours derrière le jeton. Les vignettes partent en data URL dans
// la liste (une balise img n'envoie pas le jeton), le fichier en taille réelle est lu par fetch.

/** Routes sous /api/lieux/:id/medias */
export const mediasLieuRouter = Router();
/** Routes sous /api/medias/:uuid */
export const mediasRouter = Router();

const voitMedias = exiger("ADMIN", "COMMERCIAL", "PARTENAIRE");

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const filtresSchema = z.object({
  evenement: z.coerce.number().int().positive().optional(),
  type: z.string().trim().min(1).max(40).optional(),
  du: z.string().regex(JOUR).optional(),
  au: z.string().regex(JOUR).optional(),
  // Les séances de test (is_fake, testMode) sont cachées sauf demande
  tests: z.enum(["0", "1"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  parPage: z.coerce.number().int().min(1).max(96).default(48),
});

/** Minuit à Paris du jour AAAA-MM-JJ, en UTC. */
function minuitParis(ymd: string, plusJours = 0): Date {
  const [a, m, j] = ymd.split("-").map(Number);
  return new Date(new TZDate(a, m - 1, j + plusJours, 0, 0, 0, FUSEAU_METIER).getTime());
}

const lieuParam = (req: UtilisateurRequest) => {
  const lieuId = Number(req.params.id);
  if (!Number.isInteger(lieuId)) throw new HttpError(404, "INTROUVABLE");
  return lieuId;
};

const selectionEvenement = { select: { id: true, code: true, nom: true, habituel: true } } as const;

async function vignetteDataUrl(chemin: string | null): Promise<string | null> {
  if (!chemin) return null;
  try {
    return `data:image/jpeg;base64,${(await lireBuffer(chemin)).toString("base64")}`;
  } catch {
    return null; // fichier manquant sur le disque : la ligne reste visible, sans image
  }
}

type MediaListe = Prisma.MediaGetPayload<{ include: { evenement: typeof selectionEvenement } }>;

async function versClient(m: MediaListe) {
  const ext = m.mediaChemin ? extensionDuChemin(m.mediaChemin) : "";
  return {
    uuid: m.uuid,
    filename: m.filename,
    nomFichier: m.nomFichier,
    codeEvent: m.codeEvent,
    type: m.typeMedia,
    video: EXTENSIONS_VIDEO.has(ext),
    extension: ext || null,
    borne: m.borneIdentifiant,
    datePhoto: m.datePhoto,
    datePrint: m.datePrint,
    nbTirages: m.nbTirages,
    test: m.test,
    statut: m.mediaStatut,
    jsonRecu: m.dataStatut === "TELECHARGE",
    taille: m.tailleOctets,
    recuLe: m.createdAt,
    evenement: m.evenement,
    vignette: m.mediaStatut === "TELECHARGE" ? await vignetteDataUrl(m.vignetteChemin) : null,
  };
}

// GET /api/lieux/:id/medias?evenement=&type=&du=&au=&tests=1&page=&parPage= — les médias du lieu, les plus récents d'abord
mediasLieuRouter.get(
  "/:id/medias",
  voitMedias,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = lieuParam(req);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const f = filtresSchema.parse(req.query);
    const where: Prisma.MediaWhereInput = {
      lieuId,
      ...(f.evenement ? { configEvenementId: f.evenement } : {}),
      ...(f.type ? { typeMedia: f.type } : {}),
      ...(f.tests === "1" ? {} : { test: false }),
      ...(f.du || f.au ? { datePhoto: { ...(f.du ? { gte: minuitParis(f.du) } : {}), ...(f.au ? { lt: minuitParis(f.au, 1) } : {}) } } : {}),
    };
    const [total, lignes] = await Promise.all([
      prisma.media.count({ where }),
      prisma.media.findMany({
        where,
        include: { evenement: selectionEvenement },
        // Sans date de prise de vue (JSON pas encore reçu) : en tête, ce sont les plus récents
        orderBy: [{ datePhoto: { sort: "desc", nulls: "first" } }, { id: "desc" }],
        skip: (f.page - 1) * f.parPage,
        take: f.parPage,
      }),
    ]);
    res.json({ total, page: f.page, parPage: f.parPage, medias: await Promise.all(lignes.map(versClient)) });
  })
);

// GET /api/lieux/:id/medias/resume — compteurs par événement et par type (séances de test exclues)
mediasLieuRouter.get(
  "/:id/medias/resume",
  voitMedias,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = lieuParam(req);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const where = { lieuId, test: false };
    const [total, derniere, parEvenement, parType, evenements, enAttente, enErreur] = await Promise.all([
      prisma.media.count({ where }),
      prisma.media.aggregate({ where, _max: { datePhoto: true } }),
      prisma.media.groupBy({ by: ["codeEvent", "configEvenementId"], where, _count: { _all: true } }),
      prisma.media.groupBy({ by: ["typeMedia"], where, _count: { _all: true }, orderBy: { _count: { typeMedia: "desc" } } }),
      prisma.configEvenement.findMany({ where: { lieuId }, select: { id: true, code: true, nom: true, habituel: true }, orderBy: [{ habituel: "desc" }, { id: "asc" }] }),
      // Fichiers pas encore copiés (le worker repasse chaque minute) et fichiers abandonnés (relance manuelle ou renvoi PikCloud)
      prisma.media.count({ where: { lieuId, OR: [{ mediaStatut: "A_TELECHARGER" }, { dataStatut: "A_TELECHARGER" }] } }),
      prisma.media.count({ where: { lieuId, OR: [{ mediaStatut: "ERREUR" }, { dataStatut: "ERREUR" }] } }),
    ]);
    const comptes = new Map(parEvenement.map((g) => [g.codeEvent, g._count._all]));
    res.json({
      total,
      derniere: derniere._max.datePhoto,
      enAttente,
      enErreur,
      // Tous les événements du lieu, même sans média : le sélecteur de la galerie les liste tous
      parEvenement: evenements.map((e) => ({ ...e, total: comptes.get(e.code) ?? 0 })),
      parType: parType.map((g) => ({ type: g.typeMedia, total: g._count._all })),
    });
  })
);

const admin = exiger("ADMIN");

/** Condition « fichier à relancer » : annoncé (URL connue) et pas encore copié, ou abandonné après les tentatives. */
const aRelancer: Prisma.MediaWhereInput = {
  OR: [
    { mediaUrl: { not: null }, mediaStatut: { in: ["A_TELECHARGER", "ERREUR"] } },
    { dataUrl: { not: null }, dataStatut: { in: ["A_TELECHARGER", "ERREUR"] } },
  ],
};

/** Remet en attente les fichiers d'un média (ou d'un lot) et réveille le worker. */
async function relancer(where: Prisma.MediaWhereInput): Promise<number> {
  // Deux passes : chaque fichier ne repasse en attente que s'il a une URL et n'est pas déjà reçu
  const [m, d] = await Promise.all([
    prisma.media.updateMany({ where: { ...where, mediaUrl: { not: null }, mediaStatut: { in: ["A_TELECHARGER", "ERREUR"] } }, data: { mediaStatut: "A_TELECHARGER", tentatives: 0, derniereErreur: null } }),
    prisma.media.updateMany({ where: { ...where, dataUrl: { not: null }, dataStatut: { in: ["A_TELECHARGER", "ERREUR"] } }, data: { dataStatut: "A_TELECHARGER", tentatives: 0, derniereErreur: null } }),
  ]);
  const n = await prisma.media.count({ where: { ...where, ...aRelancer } });
  if (m.count + d.count) declencherTelechargement();
  return n;
}

// POST /api/lieux/:id/medias/relancer — relance tous les téléchargements en attente ou en erreur du lieu (admin)
mediasLieuRouter.post(
  "/:id/medias/relancer",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = lieuParam(req);
    await verifierAccesLieu(req.utilisateur, lieuId);
    res.json({ relances: await relancer({ lieuId }) });
  })
);

// ─── Un média ───

const uuidParam = z.uuid();

/** Le média visé, si l'utilisateur voit son lieu ; sans lieu (événement inconnu), admin seulement. */
async function mediaAccessible(req: UtilisateurRequest) {
  const uuid = uuidParam.safeParse(req.params.uuid);
  if (!uuid.success) throw new HttpError(404, "INTROUVABLE");
  const m = await prisma.media.findUnique({ where: { uuid: uuid.data }, include: { evenement: selectionEvenement } });
  if (!m) throw new HttpError(404, "INTROUVABLE");
  if (m.lieuId === null) {
    if (req.utilisateur?.role !== "ADMIN") throw new HttpError(404, "INTROUVABLE");
  } else {
    await verifierAccesLieu(req.utilisateur, m.lieuId);
  }
  return m;
}

// GET /api/medias/:uuid — détail : la séance, sa vente et son parcours s'ils portent le même photo_uuid
mediasRouter.get(
  "/:uuid",
  voitMedias,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const m = await mediaAccessible(req);
    const [vente, parcours] = m.photoUuid
      ? await Promise.all([
          prisma.transaction.findFirst({
            where: { pikcloudUuid: m.photoUuid },
            select: { id: true, horodatage: true, statut: true, montantTtcCents: true, moyenPaiement: true, nbTirages: true, produitLibelle: true },
            orderBy: { id: "asc" },
          }),
          prisma.parcours.findFirst({ where: { photoUuid: m.photoUuid }, select: { id: true, issue: true, dureeS: true, tirages: true } }),
        ])
      : [null, null];
    // Page souvenir de la séance : la base du QR imprimé, avec le jeton code d'événement + photo_uuid tel que la borne l'écrit
    const uuidBorne = typeof (m.brut as { photo_uuid?: unknown } | null)?.photo_uuid === "string" ? (m.brut as { photo_uuid: string }).photo_uuid : m.photoUuid;
    res.json({
      ...(await versClient(m)),
      photoUuid: m.photoUuid,
      pageSouvenir: uuidBorne ? QR_BASE_URL.replace("#TOKEN#", `${m.codeEvent}${uuidBorne}`) : null,
      dateSave: m.dateSave,
      lieuId: m.lieuId,
      sha256: m.sha256,
      telechargeLe: m.telechargeLe,
      derniereErreur: m.derniereErreur,
      vente,
      parcours,
    });
  })
);

// POST /api/medias/:uuid/relancer — remet les fichiers du média en attente et réveille le worker (admin)
mediasRouter.post(
  "/:uuid/relancer",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const m = await mediaAccessible(req);
    const relances = await relancer({ id: m.id });
    const apres = await prisma.media.findUniqueOrThrow({ where: { id: m.id }, include: { evenement: selectionEvenement } });
    res.json({ relances, media: await versClient(apres) });
  })
);

function envoyerFichier(res: import("express").Response, chemin: string, nom: string, taille: number | null, telecharger: boolean) {
  res.setHeader("Content-Type", mimeDe(chemin));
  if (taille) res.setHeader("Content-Length", String(taille));
  res.setHeader("Content-Disposition", `${telecharger ? "attachment" : "inline"}; filename="${nom}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  const flux = lireFlux(chemin);
  flux.on("error", () => {
    if (!res.headersSent) res.status(404).json({ error: "FICHIER_ABSENT" });
    else res.destroy();
  });
  flux.pipe(res);
}

// GET /api/medias/:uuid/fichier?telecharger=1 — le média en taille réelle (image ou vidéo)
mediasRouter.get(
  "/:uuid/fichier",
  voitMedias,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const m = await mediaAccessible(req);
    if (m.mediaStatut !== "TELECHARGE" || !m.mediaChemin) throw new HttpError(404, "FICHIER_ABSENT", "Média pas encore téléchargé, ou purgé");
    // Nom de téléchargement : celui de PikCloud, préfixé du code d'événement
    envoyerFichier(res, m.mediaChemin, `${m.codeEvent}-${m.nomFichier ?? `${m.filename}.${extensionDuChemin(m.mediaChemin)}`}`, m.tailleOctets, req.query.telecharger === "1");
  })
);

// GET /api/medias/:uuid/vignette — la vignette JPEG (images seulement)
mediasRouter.get(
  "/:uuid/vignette",
  voitMedias,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const m = await mediaAccessible(req);
    if (m.mediaStatut !== "TELECHARGE" || !m.vignetteChemin) throw new HttpError(404, "FICHIER_ABSENT");
    envoyerFichier(res, m.vignetteChemin, `${m.codeEvent}-${m.filename}-vignette.jpg`, null, false);
  })
);
