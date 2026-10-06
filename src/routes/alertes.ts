import { Router } from "express";
import { AlerteStatut, NiveauAlerte, Prisma, type TypeAlerte } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { evaluerAlertes } from "../alertes/evaluation.js";
import { envoyerRecapitulatif, LIBELLES, notifierAlertes } from "../alertes/notifications.js";
import { chargerRegles, REGLES_DEFAUT, TYPES_REGLES, type TypeRegle } from "../alertes/regles.js";

export const alertesRouter = Router();

const TECHNIQUES: TypeAlerte[] = ["BORNE_MUETTE", "ZERO_VENTE", "TAUX_REFUS", "CONSOMMABLES", "BORNE_NON_AFFECTEE"];
const COMMERCIALES: TypeAlerte[] = ["BAISSE_CA", "ZERO_VENTE", "PIC_SUSPECT", "VENTE_HORS_HORAIRES", "TAUX_REFUS"];

/** Alertes visibles selon le rôle : technicien = techniques, commercial = ses lieux. */
function perimetre(req: UtilisateurRequest): Prisma.AlerteWhereInput {
  const u = req.utilisateur!;
  if (u.role === "ADMIN") return {};
  if (u.role === "TECHNICIEN") return { type: { in: TECHNIQUES } };
  if (u.role === "COMMERCIAL") return { type: { in: COMMERCIALES }, lieu: { commercialId: u.id } };
  throw new HttpError(403, "INTERDIT");
}

// GET /api/alertes?statut=NOUVELLE,PRISE_EN_CHARGE&niveau=&type=&lieuId=
alertesRouter.get(
  "/",
  exiger("ADMIN", "TECHNICIEN", "COMMERCIAL"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const statuts = req.query.statut ? (String(req.query.statut).split(",") as AlerteStatut[]) : undefined;
    const alertes = await prisma.alerte.findMany({
      where: {
        AND: [
          perimetre(req),
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
    if (req.utilisateur?.role === "PARTENAIRE") return res.json({ nouvelles: 0, critiques: 0 });
    const where = { AND: [perimetre(req), { statut: "NOUVELLE" as const }] };
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
  exiger("ADMIN", "TECHNICIEN", "COMMERCIAL"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const patch = z
      .object({
        statut: z.enum(AlerteStatut).optional(),
        commentaire: z.string().trim().max(2000).nullable().optional(),
        assigneeId: z.number().int().positive().nullable().optional(),
      })
      .parse(req.body);
    const id = Number(req.params.id);
    const alerte = await prisma.alerte.findFirst({ where: { AND: [{ id }, perimetre(req)] } });
    if (!alerte) throw new HttpError(404, "INTROUVABLE");

    const data: Prisma.AlerteUncheckedUpdateInput = { ...patch };
    if (patch.statut === "PRISE_EN_CHARGE" && patch.assigneeId === undefined && !alerte.assigneeId) data.assigneeId = req.utilisateur!.id;
    if (patch.statut === "RESOLUE" || patch.statut === "IGNOREE") data.resolueLe = new Date();
    if (patch.statut === "NOUVELLE" || patch.statut === "PRISE_EN_CHARGE") data.resolueLe = null;
    res.json(await prisma.alerte.update({ where: { id }, data }));
  })
);

// GET /api/alertes/regles — règles en vigueur (globales), avec leurs valeurs par défaut
alertesRouter.get(
  "/regles",
  exiger("ADMIN"),
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
  exiger("ADMIN"),
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
  exiger("ADMIN"),
  asynchrone(async (_req, res) => {
    const { creees, resolues } = await evaluerAlertes();
    await notifierAlertes(creees);
    res.json({ creees: creees.length, resolues });
  })
);

// POST /api/alertes/recapitulatif — envoyer le récapitulatif maintenant (test)
alertesRouter.post(
  "/recapitulatif",
  exiger("ADMIN"),
  asynchrone(async (_req, res) => {
    res.json(await envoyerRecapitulatif());
  })
);
