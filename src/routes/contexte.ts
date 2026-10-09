import { Router } from "express";
import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { FUSEAU_METIER } from "../lib/temps.js";
import { exiger, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { localParis } from "../alertes/ouverture.js";
import { aujourdhui, debutsEquipement } from "../previsions/service.js";
import { chargerContexte, effets, indicesDesLieux, type Indice } from "../calendrier/contexte.js";
import { libelleTemps } from "../calendrier/meteo.js";
import { impact, type VentesJour } from "../evenements/impact.js";
import { conditionsLieu, et } from "../stats/filtres.js";
import { filtresAutorises } from "./stats.js";

// Calendrier, météo et journal d'événements (CDC V3 et §8)
const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const jourIso = z.iso.date().transform((v) => new Date(`${v}T00:00:00Z`));
const selectOuverture = { saisonnalite: true, horaires: true, saisons: true, fermetures: true } as const;

/** Période demandée, ou les 12 derniers mois (il faut du recul pour mesurer un effet). */
function periode(query: Record<string, unknown>) {
  const hier = new Date(aujourdhui().getTime() - JOUR);
  const au = query.au ? jourIso.parse(query.au) : hier;
  const du = query.du ? jourIso.parse(query.du) : new Date(au.getTime() - 364 * JOUR);
  if (du > au) throw new HttpError(400, "PERIODE_INVALIDE");
  return { du, au, hier };
}

export const contexteRouter = Router();

// GET /api/stats/contexte/lieux/:id?du&au — effets mesurés et calendrier/météo jour par jour (pour les courbes)
contexteRouter.get(
  "/lieux/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const lieu = await prisma.lieu.findUnique({ where: { id: lieuId }, select: { id: true, codePostal: true, latitude: true, ...selectOuverture } });
    if (!lieu) throw new HttpError(404, "INTROUVABLE");
    const { du, au, hier } = periode(req.query);
    const indices = (await indicesDesLieux([lieu], du, au, hier)).get(lieuId)!;

    // Calendrier et météo de la période, et des 10 prochains jours (prévisions météo)
    const finCalendrier = new Date(Math.max(au.getTime(), aujourdhui().getTime() + 10 * JOUR));
    const ctx = (await chargerContexte([lieu], du, finCalendrier))(lieuId);
    const jours = [];
    for (let t = du.getTime(); t <= finCalendrier.getTime(); t += JOUR) {
      const j = ymd(new Date(t));
      const c = ctx.jour(j);
      if (c.ferie || c.vacances || c.meteo) jours.push({ jour: j, ...c, temps: libelleTemps(c.meteo?.codeWmo) });
    }
    res.json({
      du: ymd(du),
      au: ymd(au),
      zoneScolaire: ctx.zone,
      geolocalise: lieu.latitude !== null,
      effets: effets(indices),
      jours,
    });
  })
);

// GET /api/stats/contexte?<filtres>&du&au — effets par type de lieu, sur les lieux actifs filtrés
contexteRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const f = filtresAutorises(req);
    const { du, au, hier } = periode(req.query);
    const ids = (
      await prisma.$queryRaw<{ id: number }[]>`SELECT l.id FROM lieux l WHERE ${et([Prisma.sql`l.statut = 'ACTIF'`, ...conditionsLieu(f)])}`
    ).map((r) => r.id);
    const lieux = await prisma.lieu.findMany({
      where: { id: { in: ids } },
      select: { id: true, codePostal: true, typeLieu: { select: { id: true, libelle: true } }, ...selectOuverture },
    });
    const indices = await indicesDesLieux(lieux, du, au, hier);
    const groupes = new Map<string, { libelle: string; lieux: number; indices: Indice[] }>();
    for (const l of lieux) {
      const g = groupes.get(l.typeLieu.libelle) ?? { libelle: l.typeLieu.libelle, lieux: 0, indices: [] };
      const li = indices.get(l.id) ?? [];
      if (!li.length) continue;
      g.lieux++;
      g.indices.push(...li);
      groupes.set(g.libelle, g);
    }
    const tous = [...groupes.values()].flatMap((g) => g.indices);
    res.json({
      du: ymd(du),
      au: ymd(au),
      ensemble: { libelle: "Tous les lieux", lieux: [...groupes.values()].reduce((s, g) => s + g.lieux, 0), ...effets(tous) },
      typesLieu: [...groupes.values()].sort((a, b) => b.indices.length - a.indices.length).map((g) => ({ libelle: g.libelle, lieux: g.lieux, ...effets(g.indices) })),
    });
  })
);

// ─── Journal d'événements ───

/** Jour « AAAA-MM-JJ » → minuit à Paris. */
const minuitParis = (d: Date) => new Date(new TZDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), FUSEAU_METIER).getTime());

const evenementSchema = z
  .object({
    typeId: z.number().int().positive(),
    libelle: z.string().trim().min(1).max(200),
    debut: jourIso,
    fin: jourIso.nullable().optional(),
  })
  .refine((e) => !e.fin || e.fin >= e.debut, { message: "La fin précède le début", path: ["fin"] });

const ecrire = exiger("ADMIN", "COMMERCIAL", "TECHNICIEN");

/** Ventes par jour d'un lieu (CA TTC et nombre de ventes acceptées). */
async function ventesParJour(lieuId: number, du: Date) {
  const lignes = await prisma.$queryRaw<{ jour: Date; ca: number; nb: number }[]>`
    SELECT jour, sum(ca_ttc_cents)::float8 ca, sum(nb_acceptees)::float8 nb FROM agg_jour
    WHERE lieu_id = ${lieuId} AND jour >= ${ymd(du)}::date GROUP BY jour`;
  return new Map<string, VentesJour>(lignes.map((l) => [ymd(l.jour), { caCents: Number(l.ca), nbVentes: Number(l.nb) }]));
}

export const evenementsLieuRouter = Router();

// GET /api/lieux/:id/evenements — journal du lieu, avec l'impact mesuré de chaque événement
evenementsLieuRouter.get(
  "/:id/evenements",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const [lieu, evenements] = await Promise.all([
      prisma.lieu.findUnique({ where: { id: lieuId }, select: selectOuverture }),
      prisma.evenementLieu.findMany({ where: { lieuId }, include: { type: { select: { id: true, code: true, libelle: true } } }, orderBy: { debut: "desc" } }),
    ]);
    if (!lieu) throw new HttpError(404, "INTROUVABLE");
    const voitVentes = req.utilisateur!.role !== "TECHNICIEN";
    const hier = new Date(aujourdhui().getTime() - JOUR);
    const plusAncien = evenements.reduce((m, e) => (e.debut < m ? e.debut : m), hier);
    const [ventes, debuts] = voitVentes && evenements.length
      ? await Promise.all([ventesParJour(lieuId, new Date(localParis(plusAncien).jour.getTime() - 35 * JOUR)), debutsEquipement([lieuId])])
      : [new Map<string, VentesJour>(), new Map<number, Date | null>()];
    res.json(
      evenements.map((e) => {
        const debut = localParis(e.debut).jour;
        const fin = e.fin ? localParis(e.fin).jour : null;
        return {
          id: e.id,
          type: e.type,
          libelle: e.libelle,
          debut: ymd(debut),
          fin: fin ? ymd(fin) : null,
          impact: voitVentes ? impact(lieu, ventes, debuts.get(lieuId) ?? null, debut, fin, hier) : null,
        };
      })
    );
  })
);

// POST /api/lieux/:id/evenements { typeId, libelle, debut, fin? }
evenementsLieuRouter.post(
  "/:id/evenements",
  ecrire,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const e = evenementSchema.parse(req.body);
    await verifierType(e.typeId);
    const cree = await prisma.evenementLieu.create({
      data: { lieuId, typeId: e.typeId, libelle: e.libelle, debut: minuitParis(e.debut), fin: e.fin ? minuitParis(e.fin) : null },
    });
    res.status(201).json(cree);
  })
);

async function verifierType(typeId: number) {
  const t = await prisma.refValeur.findUnique({ where: { id: typeId } });
  if (t?.categorie !== "TYPE_EVENEMENT") throw new HttpError(400, "TYPE_INVALIDE", "Type d'événement inconnu");
}

export const evenementsRouter = Router();

async function evenementAccessible(req: UtilisateurRequest) {
  const e = await prisma.evenementLieu.findUnique({ where: { id: Number(req.params.id) } });
  if (!e) throw new HttpError(404, "INTROUVABLE");
  await verifierAccesLieu(req.utilisateur, e.lieuId);
  return e;
}

// PUT /api/evenements/:id
evenementsRouter.put(
  "/:id",
  ecrire,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const ancien = await evenementAccessible(req);
    const e = evenementSchema.parse(req.body);
    await verifierType(e.typeId);
    res.json(
      await prisma.evenementLieu.update({
        where: { id: ancien.id },
        data: { typeId: e.typeId, libelle: e.libelle, debut: minuitParis(e.debut), fin: e.fin ? minuitParis(e.fin) : null },
      })
    );
  })
);

// DELETE /api/evenements/:id
evenementsRouter.delete(
  "/:id",
  ecrire,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const e = await evenementAccessible(req);
    await prisma.evenementLieu.delete({ where: { id: e.id } });
    res.status(204).end();
  })
);
