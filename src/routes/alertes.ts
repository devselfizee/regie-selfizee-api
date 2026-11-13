import { Router } from "express";
import { AlerteStatut, NiveauAlerte, Prisma, type TypeAlerte } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { type UtilisateurRequest } from "../middleware/utilisateur.js";
import { evaluerAlertes } from "../alertes/evaluation.js";
import { envoyerRecapitulatif, LIBELLES, notifierAlertes } from "../alertes/notifications.js";
import { chargerRegles, REGLES_DEFAUT, TYPES_REGLES, type TypeRegle } from "../alertes/regles.js";
import { requirePerm, requireAnyPerm, userCan } from "../middleware/permissions.js";

export const alertesRouter = Router();

const TECHNIQUES: TypeAlerte[] = ["BORNE_MUETTE", "ZERO_VENTE", "TAUX_REFUS", "CONSOMMABLES", "BORNE_NON_AFFECTEE"];
const COMMERCIALES: TypeAlerte[] = ["BAISSE_CA", "ZERO_VENTE", "PIC_SUSPECT", "VENTE_HORS_HORAIRES", "TAUX_REFUS"];

// Alertes d'un lieu ou d'une borne supprimés (super admin, 13/11) : plus affichées ni comptées
const SANS_SUPPRIMES: Prisma.AlerteWhereInput = {
  AND: [{ OR: [{ lieuId: null }, { lieu: { supprimeLe: null } }] }, { OR: [{ borneId: null }, { borne: { supprimeLe: null } }] }],
};

/** Alertes visibles selon les droits : techniques (alertes.techniques_view) et/ou de vente (alertes.ventes_view). */
async function perimetre(req: UtilisateurRequest): Promise<Prisma.AlerteWhereInput> {
  const [techniques, ventes] = await Promise.all([userCan(req, "alertes.techniques_view"), userCan(req, "alertes.ventes_view")]);
  if (techniques && ventes) return {};
  if (techniques) return { type: { in: TECHNIQUES } };
  if (ventes) return { type: { in: COMMERCIALES } };
  throw new HttpError(403, "INTERDIT");
}

// GET /api/alertes?statut=NOUVELLE,PRISE_EN_CHARGE&niveau=&type=&lieuId=
alertesRouter.get(
  "/",
  requireAnyPerm("alertes.techniques_view", "alertes.ventes_view"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const statuts = req.query.statut ? (String(req.query.statut).split(",") as AlerteStatut[]) : undefined;
    const alertes = await prisma.alerte.findMany({
      where: {
        AND: [
          await perimetre(req),
          SANS_SUPPRIMES,
          statuts ? { statut: { in: statuts } } : {},
          req.query.niveau ? { niveau: req.query.niveau as NiveauAlerte } : {},
          req.query.type ? { type: req.query.type as TypeAlerte } : {},
          req.query.lieuId ? { lieuId: Number(req.query.lieuId) } : {},
        ],
      },
      include: {
        lieu: { select: { id: true, enseigne: true } },
        borne: { select: { id: true, identifiant: true } },
        assignee: { select: { id: true, nom: true, prenom: true } },
      },
      orderBy: [{ detecteeLe: "desc" }],
      take: 300,
    });
    res.json(alertes.map((a) => ({ ...a, libelleType: LIBELLES[a.type] })));
  })
);

// GET /api/alertes/compteur — nouvelles alertes visibles (badge du menu)
alertesRouter.get(
  "/compteur",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    // Sans droit sur les alertes (partenaire…) : pas de badge
    if (!(await userCan(req, "alertes.techniques_view")) && !(await userCan(req, "alertes.ventes_view"))) return res.json({ nouvelles: 0, critiques: 0 });
    const where = { AND: [await perimetre(req), SANS_SUPPRIMES, { statut: "NOUVELLE" as const }] };
    const [nouvelles, critiques] = await Promise.all([
      prisma.alerte.count({ where }),
      prisma.alerte.count({ where: { AND: [...where.AND, { niveau: "CRITIQUE" as const }] } }),
    ]);
    res.json({ nouvelles, critiques });
  })
);

// PATCH /api/alertes/:id { statut?, commentaire?, assigneeId? }
alertesRouter.patch(
  "/:id",
  requirePerm("alertes.traiter"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const patch = z
      .object({
        statut: z.enum(AlerteStatut).optional(),
        commentaire: z.string().trim().max(2000).nullable().optional(),
        assigneeId: z.number().int().positive().nullable().optional(),
      })
      .parse(req.body);
    const id = Number(req.params.id);
    const alerte = await prisma.alerte.findFirst({ where: { AND: [{ id }, await perimetre(req)] } });
    if (!alerte) throw new HttpError(404, "INTROUVABLE");

    const data: Prisma.AlerteUncheckedUpdateInput = { ...patch };
    if (patch.statut === "PRISE_EN_CHARGE" && patch.assigneeId === undefined && !alerte.assigneeId) data.assigneeId = req.utilisateur!.id;
    if (patch.statut === "RESOLUE" || patch.statut === "IGNOREE") data.resolueLe = new Date();
    if (patch.statut === "NOUVELLE" || patch.statut === "PRISE_EN_CHARGE") data.resolueLe = null;
    const maj = await prisma.alerte.update({ where: { id }, data });
    // Qui a résolu ou commenté : affiché dans le suivi du lieu (réponse à l'alerte)
    if (patch.statut !== undefined || patch.commentaire !== undefined)
      await prisma.auditLog.create({
        data: { userId: req.utilisateur!.id, entite: "alerte", entiteId: String(id), action: patch.statut ?? "COMMENTAIRE", avant: { statut: alerte.statut, commentaire: alerte.commentaire }, apres: patch },
      });
    res.json(maj);
  })
);

// GET /api/alertes/regles — règles en vigueur (globales), avec leurs valeurs par défaut
alertesRouter.get(
  "/regles",
  requirePerm("alertes.regles_edit"),
  asynchrone(async (_req, res) => {
    const regle = await chargerRegles();
    res.json(
      TYPES_REGLES.map((type) => ({
        type,
        libelle: LIBELLES[type],
        ...regle(type),
        defaut: REGLES_DEFAUT[type],
      }))
    );
  })
);

// PUT /api/alertes/regles/:type — règle globale { actif, niveau, parametres }
alertesRouter.put(
  "/regles/:type",
  requirePerm("alertes.regles_edit"),
  asynchrone(async (req, res) => {
    const type = req.params.type as TypeRegle;
    if (!TYPES_REGLES.includes(type)) throw new HttpError(404, "INTROUVABLE");
    const cles = Object.keys(REGLES_DEFAUT[type].parametres) as [string, ...string[]];
    const corps = z
      .object({
        actif: z.boolean(),
        niveau: z.enum(NiveauAlerte),
        parametres: z.object(Object.fromEntries(cles.map((k) => [k, z.number().min(0)]))).partial(),
      })
      .parse(req.body);
    const existante = await prisma.regleAlerte.findFirst({ where: { type, lieuId: null } });
    const data = { actif: corps.actif, niveau: corps.niveau, parametres: corps.parametres as Prisma.InputJsonValue };
    const r = existante
      ? await prisma.regleAlerte.update({ where: { id: existante.id }, data })
      : await prisma.regleAlerte.create({ data: { type, ...data } });
    res.json(r);
  })
);

// POST /api/alertes/evaluer — évaluer maintenant (sinon toutes les 15 min)
alertesRouter.post(
  "/evaluer",
  requirePerm("alertes.regles_edit"),
  asynchrone(async (_req, res) => {
    const { creees, resolues } = await evaluerAlertes();
    await notifierAlertes(creees);
    res.json({ creees: creees.length, resolues });
  })
);

// POST /api/alertes/recapitulatif — envoyer le récapitulatif maintenant (test)
alertesRouter.post(
  "/recapitulatif",
  requirePerm("alertes.regles_edit"),
  asynchrone(async (_req, res) => {
    res.json(await envoyerRecapitulatif());
  })
);
