import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { avecGrilleDuLieu, controler, reglagesParDefaut, reglagesSchema, type Reglages } from "../config-evenement/reglages.js";
import { grilleEffective } from "../tarifs/grille.js";
import { genererConfig, lireModele, type HoraireOuverture } from "../config-evenement/generation.js";
import { genererZip } from "../config-evenement/zip.js";
import { chemins, cible, creerEvenement, evenementDe } from "../config-evenement/acces.js";

// Fiche événement d'un lieu (CDC page souvenir § 13) : la configuration de la borne, réservée aux admins.
// Montée sous /api/lieux, à côté des routes de la fiche lieu. Un lieu a son événement habituel et des
// événements ponctuels (Halloween, une soirée…), chacun avec son code, ses cadres et ses tarifs ; on passe
// de l'un à l'autre en tapant le code sur la borne. Chaque route existe pour les deux (acces.ts).
export const configEvenementRouter = Router();
const admin = exiger("ADMIN");

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

/** Cadres dessinés au studio pour cet événement (JSON Fabric, et rendu PNG pour le zip). */
const cadresDe = (evenementId: number, avecImage = false) =>
  prisma.cadreEvenement.findMany({ where: { configEvenementId: evenementId }, select: { compositionId: true, canvas: true, image: avecImage } });

async function charger(lieuId: number, eid: number | null) {
  const lieu = await prisma.lieu.findUnique({
    where: { id: lieuId },
    select: {
      id: true, enseigne: true, ville: true, dateInstallation: true,
      // Horaires de toute l'année (les horaires de saison ne sont pas transmis à la borne)
      horaires: { where: { saisonId: null }, select: { jourSemaine: true, ouverture: true, fermeture: true } },
    },
  });
  if (!lieu) throw new HttpError(404, "INTROUVABLE");
  const evenement = await evenementDe(lieuId, eid);
  const horaires: HoraireOuverture[] = lieu.horaires.map((h) => ({ jourSemaine: h.jourSemaine, ouverture: hhmm(h.ouverture), fermeture: hhmm(h.fermeture) }));
  // Tarifs par défaut du lieu (les siens, sinon ceux de base du parc) : repris par l'événement qui en hérite
  const tarifsLieu = await grilleEffective(lieuId);
  return { lieu, evenement, horaires, tarifsLieu };
}
type Charge = Awaited<ReturnType<typeof charger>>;

/** Réglages enregistrés, avec la grille du lieu si l'événement en hérite (ce que la borne recevra). */
const reglagesEffectifs = (brut: unknown, tarifsLieu: Charge["tarifsLieu"]) => avecGrilleDuLieu(reglagesSchema.parse(brut), tarifsLieu.grille);

/** Le config.json d'un événement enregistré, d'après ses réglages et ses cadres. */
async function configDe({ evenement: e, horaires, tarifsLieu }: Charge, maintenant: Date, reglages?: Reglages) {
  if (!e) throw new HttpError(404, "PAS_ENCORE_ENREGISTRE", "Enregistrez d'abord la fiche événement");
  const r = reglages ?? reglagesEffectifs(e.reglages, tarifsLieu);
  const cadres = await cadresDe(e.id);
  return genererConfig({ code: e.code, motDePasseTableau: e.motDePasseTableau, reglages: r, horaires, maintenant, cadres, nomEvenement: e.habituel ? null : e.nom });
}

function reponse({ lieu, evenement: e, horaires, tarifsLieu }: Charge) {
  // Réglages enregistrés relus avec le schéma : les champs ajoutés depuis prennent leur défaut
  const reglages: Reglages = avecGrilleDuLieu(e ? reglagesSchema.parse(e.reglages) : reglagesParDefaut(lieu), tarifsLieu.grille);
  return {
    id: e?.id ?? null,
    habituel: e ? e.habituel : true,
    nom: e?.nom ?? null,
    tarifsLieu,
    enregistre: Boolean(e),
    code: e?.code ?? null,
    // Mot de passe du tableau de bord de la borne (customerDashboardPassword du config.json), à donner à l'exploitant
    motDePasseTableau: e?.motDePasseTableau ?? null,
    version: e?.version ?? 0,
    publieeLe: e?.publieeLe ?? null,
    // La version enregistrée diffère-t-elle de la dernière publiée ?
    modifieDepuisPublication: e ? e.publieeLe === null || e.updatedAt > e.publieeLe : false,
    reglages,
    horaires,
    controles: controler(reglages, horaires.length > 0),
  };
}

const nomSchema = z.string().trim().min(1).max(80);

// ─── Événements ponctuels du lieu ───────────────────────────

// GET /api/lieux/:id/evenements-ponctuels — la liste, du plus récent au plus ancien
configEvenementRouter.get(
  "/:id/evenements-ponctuels",
  admin,
  asynchrone(async (req, res) => {
    const lieuId = Number(req.params.id);
    const liste = await prisma.configEvenement.findMany({
      where: { lieuId, habituel: false },
      select: { id: true, nom: true, code: true, reglages: true, version: true, publieeLe: true, updatedAt: true },
    });
    res.json(
      liste
        .map((e) => {
          const r = reglagesSchema.parse(e.reglages);
          return {
            id: e.id, nom: e.nom, code: e.code, dateDebut: r.lieu.dateDebut, dateFin: r.lieu.dateFin,
            version: e.version, publieeLe: e.publieeLe, modifieDepuisPublication: e.publieeLe === null || e.updatedAt > e.publieeLe,
          };
        })
        .sort((a, b) => b.dateDebut.localeCompare(a.dateDebut))
    );
  })
);

// POST /api/lieux/:id/evenements-ponctuels { nom, dateDebut, dateFin } — crée un événement ponctuel : il
// reprend les réglages de l'événement habituel (ou ceux par défaut) et les tarifs du lieu, sans les cadres
configEvenementRouter.post(
  "/:id/evenements-ponctuels",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    const saisie = z.object({ nom: nomSchema, dateDebut: z.iso.date(), dateFin: z.iso.date() }).parse(req.body);
    if (saisie.dateFin < saisie.dateDebut) throw new HttpError(400, "DATES", "La date de fin est avant la date de début.");
    const { lieu, evenement: habituel } = await charger(lieuId, null);
    const base = habituel ? reglagesSchema.parse(habituel.reglages) : reglagesParDefaut(lieu);
    const reglages: Reglages = {
      ...base,
      lieu: { ...base.lieu, dateDebut: saisie.dateDebut, dateFin: saisie.dateFin },
      tarifs: { ...base.tarifs, herite: true },
    };
    const e = await creerEvenement({ lieuId, habituel: false, nom: saisie.nom, reglages });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "config_evenement", entiteId: String(e.id), action: "CREATION", apres: { lieuId, ...saisie } },
    });
    res.status(201).json(reponse(await charger(lieuId, e.id)));
  })
);

// DELETE /api/lieux/:id/evenements-ponctuels/:eid — supprime un événement ponctuel et ses cadres
configEvenementRouter.delete(
  "/:id/evenements-ponctuels/:eid",
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const e = await evenementDe(lieuId, eid);
    await prisma.configEvenement.delete({ where: { id: e!.id } });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "config_evenement", entiteId: String(e!.id), action: "SUPPRESSION", avant: { nom: e!.nom, code: e!.code } },
    });
    res.status(204).end();
  })
);

// ─── Fiche d'un événement (habituel ou ponctuel) ────────────

// GET …/evenement — réglages enregistrés, ou réglages par défaut tirés de la fiche (habituel pas encore enregistré)
configEvenementRouter.get(
  chemins(),
  admin,
  asynchrone(async (req, res) => {
    const { lieuId, eid } = cible(req);
    res.json(reponse(await charger(lieuId, eid)));
  })
);

// PUT …/evenement { reglages, nom? } — enregistre ; l'habituel reçoit son code au premier enregistrement.
// Les cadres des compositions retirées sont supprimés.
configEvenementRouter.put(
  chemins(),
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const corps = z.object({ reglages: z.unknown(), nom: nomSchema.optional() }).parse(req.body);
    const reglages = reglagesSchema.parse(corps.reglages);
    const { evenement } = await charger(lieuId, eid);

    const e = evenement
      ? await prisma.configEvenement.update({ where: { id: evenement.id }, data: { reglages, ...(!evenement.habituel && corps.nom ? { nom: corps.nom } : {}) } })
      : await creerEvenement({ lieuId, habituel: true, nom: null, reglages });
    await prisma.cadreEvenement.deleteMany({ where: { configEvenementId: e.id, compositionId: { notIn: reglages.gabarits.choisis.map((c) => c.id) } } });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "config_evenement", entiteId: String(e.id), action: evenement ? "MODIFICATION" : "CREATION", apres: reglages },
    });
    res.json(reponse(await charger(lieuId, eid)));
  })
);

// GET …/config.json[?publiee=1] — le config.json des réglages enregistrés, ou celui publié
configEvenementRouter.get(
  chemins("/config.json"),
  admin,
  asynchrone(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const charge = await charger(lieuId, eid);
    const e = charge.evenement;
    if (!e) throw new HttpError(404, "PAS_ENCORE_ENREGISTRE", "Enregistrez d'abord la fiche événement");
    let config: unknown;
    if (req.query.publiee) {
      if (!e.configPubliee) throw new HttpError(404, "PAS_ENCORE_PUBLIE", "Cet événement n'a pas encore été publié");
      config = e.configPubliee;
    } else {
      config = await configDe(charge, e.updatedAt);
    }
    res.setHeader("Content-Disposition", `attachment; filename="config-${e.code}.json"`);
    res.type("application/json").send(JSON.stringify(config, null, 2));
  })
);

// POST …/publier — fige le config.json (nouvelle version) si aucun contrôle ne bloque
configEvenementRouter.post(
  chemins("/publier"),
  admin,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const charge = await charger(lieuId, eid);
    const e = charge.evenement;
    if (!e) throw new HttpError(400, "PAS_ENCORE_ENREGISTRE", "Enregistrez d'abord la fiche événement");
    const reglages = reglagesEffectifs(e.reglages, charge.tarifsLieu);
    const erreurs = controler(reglages, charge.horaires.length > 0).filter((x) => x.niveau === "erreur");
    if (erreurs.length) {
      res.status(400).json({ error: "CONTROLES", message: erreurs.map((x) => x.message).join(" "), controles: erreurs });
      return;
    }
    const maintenant = new Date();
    const config = await configDe(charge, maintenant, reglages);
    await prisma.$transaction([
      prisma.configEvenement.update({
        where: { id: e.id },
        // updatedAt posé à la date de publication : « modifié depuis » repart de zéro
        data: { version: { increment: 1 }, publieeLe: maintenant, configPubliee: config as Prisma.InputJsonValue, updatedAt: maintenant },
      }),
      prisma.auditLog.create({
        data: { userId: req.utilisateur?.id ?? null, entite: "config_evenement", entiteId: String(e.id), action: "PUBLICATION", apres: { code: e.code, version: e.version + 1 } },
      }),
    ]);
    res.json(reponse(await charger(lieuId, eid)));
  })
);

// GET …/zip — le zip de l'événement (config.json, cadres, aperçus, éléments du kit),
// recalculé à chaque appel : il suit les réglages et les cadres enregistrés
configEvenementRouter.get(
  chemins("/zip"),
  admin,
  asynchrone(async (req, res) => {
    const { lieuId, eid } = cible(req);
    const charge = await charger(lieuId, eid);
    const e = charge.evenement;
    if (!e) throw new HttpError(404, "PAS_ENCORE_ENREGISTRE", "Enregistrez d'abord la fiche événement");
    const reglages = reglagesEffectifs(e.reglages, charge.tarifsLieu);
    const config = await configDe(charge, e.updatedAt, reglages);
    const zip = await genererZip({ config, modele: lireModele(), reglages, cadres: await cadresDe(e.id, true), maintenant: e.updatedAt });
    res.setHeader("Content-Disposition", `attachment; filename="evenement-${e.code}.zip"`);
    res.type("application/zip").send(zip);
  })
);
