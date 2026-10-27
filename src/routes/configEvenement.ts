import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { controler, genererCodeEvenement, genererMotDePasse, reglagesParDefaut, reglagesSchema, type Reglages } from "../config-evenement/reglages.js";
import { genererConfig, lireModele, type HoraireOuverture } from "../config-evenement/generation.js";
import { genererZip } from "../config-evenement/zip.js";

// Fiche événement d'un lieu (CDC page souvenir § 13) : la configuration de la borne, réservée aux admins.
// Montée sous /api/lieux, à côté des routes de la fiche lieu.
export const configEvenementRouter = Router();
const admin = exiger("ADMIN");

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

/** Cadres dessinés au studio pour ce lieu (JSON Fabric, et rendu PNG pour le zip). */
const cadresDuLieu = (lieuId: number, avecImage = false) =>
  prisma.cadreEvenement.findMany({ where: { lieuId }, select: { gabarit: true, canvas: true, image: avecImage } });

async function charger(lieuId: number) {
  const lieu = await prisma.lieu.findUnique({
    where: { id: lieuId },
    select: {
      id: true, enseigne: true, ville: true, dateInstallation: true,
      // Horaires de toute l'année (les horaires de saison ne sont pas transmis à la borne)
      horaires: { where: { saisonId: null }, select: { jourSemaine: true, ouverture: true, fermeture: true } },
      configEvenement: true,
    },
  });
  if (!lieu) throw new HttpError(404, "INTROUVABLE");
  const horaires: HoraireOuverture[] = lieu.horaires.map((h) => ({ jourSemaine: h.jourSemaine, ouverture: hhmm(h.ouverture), fermeture: hhmm(h.fermeture) }));
  return { lieu, horaires };
}

function reponse(lieu: Awaited<ReturnType<typeof charger>>["lieu"], horaires: HoraireOuverture[]) {
  const c = lieu.configEvenement;
  // Réglages enregistrés relus avec le schéma : les champs ajoutés depuis prennent leur défaut
  const reglages: Reglages = c ? reglagesSchema.parse(c.reglages) : reglagesParDefaut(lieu);
  return {
    enregistre: Boolean(c),
    code: c?.code ?? null,
    // Mot de passe du tableau de bord de la borne (customerDashboardPassword du config.json), à donner à l'exploitant
    motDePasseTableau: c?.motDePasseTableau ?? null,
    version: c?.version ?? 0,
    publieeLe: c?.publieeLe ?? null,
    // La version enregistrée diffère-t-elle de la dernière publiée ?
    modifieDepuisPublication: c ? c.publieeLe === null || c.updatedAt > c.publieeLe : false,
    reglages,
    horaires,
    controles: controler(reglages, horaires.length > 0),
  };
}

// GET /api/lieux/:id/evenement — réglages enregistrés, ou réglages par défaut tirés de la fiche
configEvenementRouter.get(
  "/:id/evenement",
  admin,
  asynchrone(async (req, res) => {
    const { lieu, horaires } = await charger(Number(req.params.id));
    res.json(reponse(lieu, horaires));
  })
);

// PUT /api/lieux/:id/evenement { reglages } — enregistre ; attribue le code d'événement au premier enregistrement
configEvenementRouter.put(
  "/:id/evenement",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    const reglages = reglagesSchema.parse(z.object({ reglages: z.unknown() }).parse(req.body).reglages);
    const { lieu } = await charger(lieuId);

    if (lieu.configEvenement) {
      await prisma.configEvenement.update({ where: { lieuId }, data: { reglages } });
    } else {
      // Code tiré au hasard ; nouvel essai en cas de collision (31³ ≈ 30 000 codes)
      for (let essai = 0; ; essai++) {
        try {
          await prisma.configEvenement.create({ data: { lieuId, code: genererCodeEvenement(), motDePasseTableau: genererMotDePasse(), reglages } });
          break;
        } catch (e) {
          const collision = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && String(e.meta?.target).includes("code");
          if (!collision || essai >= 20) throw e;
        }
      }
    }
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "config_evenement", entiteId: String(lieuId), action: lieu.configEvenement ? "MODIFICATION" : "CREATION", apres: reglages },
    });
    const apres = await charger(lieuId);
    res.json(reponse(apres.lieu, apres.horaires));
  })
);

// GET /api/lieux/:id/evenement/config.json[?publiee=1] — le config.json des réglages enregistrés, ou celui publié
configEvenementRouter.get(
  "/:id/evenement/config.json",
  admin,
  asynchrone(async (req, res) => {
    const { lieu, horaires } = await charger(Number(req.params.id));
    const c = lieu.configEvenement;
    if (!c) throw new HttpError(404, "PAS_ENCORE_ENREGISTRE", "Enregistrez d'abord la fiche événement");
    let config: unknown;
    if (req.query.publiee) {
      if (!c.configPubliee) throw new HttpError(404, "PAS_ENCORE_PUBLIE", "Cet événement n'a pas encore été publié");
      config = c.configPubliee;
    } else {
      const cadres = await cadresDuLieu(lieu.id);
      config = genererConfig({ code: c.code, motDePasseTableau: c.motDePasseTableau, reglages: reglagesSchema.parse(c.reglages), horaires, maintenant: c.updatedAt, cadres });
    }
    res.setHeader("Content-Disposition", `attachment; filename="config-${c.code}.json"`);
    res.type("application/json").send(JSON.stringify(config, null, 2));
  })
);

// POST /api/lieux/:id/evenement/publier — fige le config.json (nouvelle version) si aucun contrôle ne bloque
configEvenementRouter.post(
  "/:id/evenement/publier",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    const { lieu, horaires } = await charger(lieuId);
    const c = lieu.configEvenement;
    if (!c) throw new HttpError(400, "PAS_ENCORE_ENREGISTRE", "Enregistrez d'abord la fiche événement");
    const reglages = reglagesSchema.parse(c.reglages);
    const erreurs = controler(reglages, horaires.length > 0).filter((x) => x.niveau === "erreur");
    if (erreurs.length) {
      res.status(400).json({ error: "CONTROLES", message: erreurs.map((x) => x.message).join(" "), controles: erreurs });
      return;
    }
    const maintenant = new Date();
    const config = genererConfig({ code: c.code, motDePasseTableau: c.motDePasseTableau, reglages, horaires, maintenant, cadres: await cadresDuLieu(lieuId) });
    await prisma.$transaction([
      prisma.configEvenement.update({
        where: { lieuId },
        // updatedAt posé à la date de publication : « modifié depuis » repart de zéro
        data: { version: { increment: 1 }, publieeLe: maintenant, configPubliee: config as Prisma.InputJsonValue, updatedAt: maintenant },
      }),
      prisma.auditLog.create({
        data: { userId: req.utilisateur?.id ?? null, entite: "config_evenement", entiteId: String(lieuId), action: "PUBLICATION", apres: { code: c.code, version: c.version + 1 } },
      }),
    ]);
    const apres = await charger(lieuId);
    res.json(reponse(apres.lieu, apres.horaires));
  })
);

// GET /api/lieux/:id/evenement/zip — le zip de l'événement (config.json, cadres, aperçus, éléments du kit),
// recalculé à chaque appel : il suit les réglages et les cadres enregistrés
configEvenementRouter.get(
  "/:id/evenement/zip",
  admin,
  asynchrone(async (req, res) => {
    const { lieu, horaires } = await charger(Number(req.params.id));
    const c = lieu.configEvenement;
    if (!c) throw new HttpError(404, "PAS_ENCORE_ENREGISTRE", "Enregistrez d'abord la fiche événement");
    const reglages = reglagesSchema.parse(c.reglages);
    const cadres = await cadresDuLieu(lieu.id, true);
    const config = genererConfig({ code: c.code, motDePasseTableau: c.motDePasseTableau, reglages, horaires, maintenant: c.updatedAt, cadres });
    const zip = await genererZip({ config, modele: lireModele(), choisis: reglages.gabarits.choisis, cadres, maintenant: c.updatedAt });
    res.setHeader("Content-Disposition", `attachment; filename="evenement-${c.code}.zip"`);
    res.type("application/zip").send(zip);
  })
);
