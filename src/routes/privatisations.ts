import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { requirePerm } from "../middleware/permissions.js";
import { ymd } from "../stats/filtres.js";
import { montantsPrivatisation } from "../stats/privatisations.js";

/**
 * Privatisations d'un lieu (demande de Sébastien du 26/11/2026) : forfait vendu au lieu (ou offert) pour un
 * événement où la borne passe en gratuit. L'événement gratuit se crée dans l'appli, comme d'habitude : ici, seulement
 * le montant, pour le chiffre d'affaires du lieu.
 */
export const privatisationsRouter = Router();

const jour = z.iso.date().transform((s) => new Date(`${s}T00:00:00Z`));

const schema = z
  .object({
    libelle: z.string().trim().min(1).max(200),
    debut: jour,
    fin: jour,
    offerte: z.boolean().default(false),
    // Montant HT en centimes ; ignoré (0) si offerte
    montantHtCents: z.number().int().min(0).max(100_000_000).default(0),
    // Taux de TVA en points de base : 2000 = 20 %
    tauxTvaBp: z.number().int().min(0).max(10_000).default(2000),
    papierInclus: z.boolean().default(true),
    note: z.string().trim().max(2000).nullish(),
  })
  .refine((p) => p.fin >= p.debut, { message: "La fin est avant le début", path: ["fin"] })
  .refine((p) => p.offerte || p.montantHtCents > 0, { message: "Montant obligatoire (ou cocher « offerte »)", path: ["montantHtCents"] });

function donnees(p: z.infer<typeof schema>) {
  return {
    libelle: p.libelle,
    debut: p.debut,
    fin: p.fin,
    offerte: p.offerte,
    tauxTvaBp: p.tauxTvaBp,
    ...montantsPrivatisation(p.montantHtCents, p.tauxTvaBp, p.offerte),
    papierInclus: p.papierInclus,
    note: p.note || null,
  };
}

const auteur = { select: { prenom: true, nom: true, photoUrl: true } } as const;

type Ligne = Prisma.PrivatisationGetPayload<{ include: { creePar: typeof auteur } }>;

const sortie = (p: Ligne) => ({
  id: p.id,
  lieuId: p.lieuId,
  libelle: p.libelle,
  debut: ymd(p.debut),
  fin: ymd(p.fin),
  offerte: p.offerte,
  montantHtCents: p.montantHtCents,
  tauxTvaBp: p.tauxTvaBp,
  montantTtcCents: p.montantTtcCents,
  papierInclus: p.papierInclus,
  note: p.note,
  auteur: p.creePar,
  createdAt: p.createdAt,
});

// GET /api/privatisations?lieuId= — toutes les privatisations du lieu, les plus récentes d'abord
privatisationsRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = z.coerce.number().int().positive().parse(req.query.lieuId);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const lignes = await prisma.privatisation.findMany({ where: { lieuId }, include: { creePar: auteur }, orderBy: [{ debut: "desc" }, { id: "desc" }] });
    res.json(lignes.map(sortie));
  })
);

// POST /api/privatisations { lieuId, libelle, debut, fin, offerte, montantHtCents, tauxTvaBp, papierInclus, note }
privatisationsRouter.post(
  "/",
  requirePerm("privatisations.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = z.coerce.number().int().positive().parse(req.body?.lieuId);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const d = donnees(schema.parse(req.body));
    const p = await prisma.privatisation.create({ data: { ...d, lieuId, creeParId: req.utilisateur?.id ?? null }, include: { creePar: auteur } });
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "privatisation", entiteId: String(p.id), action: "CREATION", apres: { ...d, lieuId, debut: ymd(d.debut), fin: ymd(d.fin) } } });
    res.status(201).json(sortie(p));
  })
);

async function accessible(req: UtilisateurRequest) {
  const p = await prisma.privatisation.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!p) throw new HttpError(404, "INTROUVABLE");
  await verifierAccesLieu(req.utilisateur, p.lieuId);
  return p;
}

const pourJournal = (p: { libelle: string; debut: Date; fin: Date; offerte: boolean; montantHtCents: number; tauxTvaBp: number; montantTtcCents: number; papierInclus: boolean; note: string | null }) => ({
  libelle: p.libelle,
  debut: ymd(p.debut),
  fin: ymd(p.fin),
  offerte: p.offerte,
  montantHtCents: p.montantHtCents,
  tauxTvaBp: p.tauxTvaBp,
  montantTtcCents: p.montantTtcCents,
  papierInclus: p.papierInclus,
  note: p.note,
});

// PUT /api/privatisations/:id
privatisationsRouter.put(
  "/:id",
  requirePerm("privatisations.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const avant = await accessible(req);
    const d = donnees(schema.parse(req.body));
    const p = await prisma.privatisation.update({ where: { id: avant.id }, data: d, include: { creePar: auteur } });
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "privatisation", entiteId: String(p.id), action: "MODIFICATION", avant: pourJournal(avant), apres: pourJournal(p) } });
    res.json(sortie(p));
  })
);

// DELETE /api/privatisations/:id
privatisationsRouter.delete(
  "/:id",
  requirePerm("privatisations.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const p = await accessible(req);
    await prisma.privatisation.delete({ where: { id: p.id } });
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "privatisation", entiteId: String(p.id), action: "SUPPRESSION", avant: { ...pourJournal(p), lieuId: p.lieuId } } });
    res.status(204).end();
  })
);
