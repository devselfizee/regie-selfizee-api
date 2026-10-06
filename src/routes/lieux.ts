import { Router } from "express";
import { ContactRole, InterieurExterieur, LieuStatut, Prisma, Saisonnalite } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import { exiger, perimetreLieux, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { geocoder } from "../lib/geocodage.js";

export const lieuxRouter = Router();

// ─── Validation ─────────────────────────────────────────────

const id = z.number().int().positive();
const idOpt = id.nullable().optional();
const texteOpt = z.string().trim().nullable().optional().transform((v) => (v === "" ? null : v));
const dateOpt = z.iso.date().nullable().optional().transform((v) => (v ? new Date(`${v}T00:00:00Z`) : v));
const date = z.iso.date().transform((v) => new Date(`${v}T00:00:00Z`));
const heure = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Format HH:MM")
  .transform((v) => new Date(`1970-01-01T${v}:00Z`));

const lieuSchema = z.object({
  statut: z.enum(LieuStatut).optional(),
  crmClientId: z.number().int().nullable().optional(),

  raisonSociale: z.string().trim().min(1),
  enseigne: z.string().trim().min(1),
  siret: z.string().regex(/^\d{14}$/, "14 chiffres").nullable().optional().or(z.literal("").transform(() => null)),
  adresse: texteOpt,
  codePostal: texteOpt,
  ville: texteOpt,
  pays: z.string().length(2).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),

  typeLieuId: id,
  sousTypeId: idOpt,
  standingId: idOpt,

  saisonnalite: z.enum(Saisonnalite).optional(),

  capaciteAccueil: z.number().int().min(0).nullable().optional(),
  frequentationJour: z.number().int().min(0).nullable().optional(),
  frequentationSemaine: z.number().int().min(0).nullable().optional(),

  zoneGeoId: idOpt,
  tailleCommuneId: idOpt,
  concurrencePhoto: z.boolean().nullable().optional(),
  concurrencePhotoNotes: texteOpt,

  interieurExterieur: z.enum(InterieurExterieur).nullable().optional(),
  emplacementZoneId: idOpt,
  visibilite: z.number().int().min(1).max(5).nullable().optional(),
  eclairageId: idOpt,

  dateSignature: dateOpt,
  dateInstallation: dateOpt,
  dureeContratMois: z.number().int().min(0).nullable().optional(),
  commercialId: idOpt,
  origineLeadId: idOpt,
  notes: texteOpt,

  // Sous-listes : remplacées intégralement à chaque enregistrement
  clienteleIds: z.array(id).optional(),
  contacts: z
    .array(
      z.object({
        role: z.enum(ContactRole),
        nom: z.string().trim().min(1),
        prenom: texteOpt,
        email: z.email().nullable().optional().or(z.literal("").transform(() => null)),
        telephone: texteOpt,
      })
    )
    .optional(),
  horaires: z
    .array(z.object({ jourSemaine: z.number().int().min(1).max(7), ouverture: heure, fermeture: heure }))
    .optional(),
  saisons: z
    .array(z.object({ libelle: texteOpt, debut: date, fin: date }).refine((s) => s.fin >= s.debut, "fin < début"))
    .optional(),
  fermetures: z
    .array(z.object({ debut: date, fin: date, motif: texteOpt }).refine((f) => f.fin >= f.debut, "fin < début"))
    .optional(),
});

type LieuInput = z.infer<typeof lieuSchema>;

function donneesLieu(input: LieuInput) {
  const { clienteleIds, contacts, horaires, saisons, fermetures, ...champs } = input;
  return { champs, clienteleIds, contacts, horaires, saisons, fermetures };
}

// ─── Lecture ────────────────────────────────────────────────

// GET /api/lieux?q=&statut=&typeLieuId=&commercialId= — limité au périmètre de l'utilisateur
lieuxRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const perimetre = perimetreLieux(req.utilisateur);
    const where: Prisma.LieuWhereInput = {
      ...(perimetre?.lieuId !== undefined ? { id: perimetre.lieuId } : {}),
      ...(req.query.statut ? { statut: req.query.statut as LieuStatut } : { statut: { not: "PROSPECT" } }),
      ...(req.query.typeLieuId ? { typeLieuId: Number(req.query.typeLieuId) } : {}),
      ...(req.query.commercialId ? { commercialId: Number(req.query.commercialId) } : {}),
      ...(perimetre?.commercialId !== undefined ? { commercialId: perimetre.commercialId } : {}),
      ...(q
        ? {
            OR: [
              { enseigne: { contains: q, mode: "insensitive" } },
              { raisonSociale: { contains: q, mode: "insensitive" } },
              { ville: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const lieux = await prisma.lieu.findMany({
      where,
      orderBy: { enseigne: "asc" },
      take: 1000,
      select: {
        id: true, enseigne: true, raisonSociale: true, ville: true, statut: true, saisonnalite: true,
        typeLieu: { select: { libelle: true } },
        commercial: { select: { nom: true, prenom: true } },
        affectations: {
          where: { fin: null },
          select: { borne: { select: { id: true, identifiant: true, dernierHeartbeat: true, derniereVente: true } } },
        },
      },
    });

    // CA des 30 derniers jours (agrégats)
    const { jour } = jourEtHeureLocaux(new Date());
    const depuis = new Date(jour.getTime() - 29 * 86_400_000);
    const ca = await prisma.aggJour.groupBy({
      by: ["lieuId"],
      where: { jour: { gte: depuis }, lieuId: { in: lieux.map((l) => l.id) } },
      _sum: { caTtcCents: true, nbAcceptees: true },
    });
    const caParLieu = new Map(ca.map((c) => [c.lieuId, c._sum]));

    const voitCa = req.utilisateur?.role !== "TECHNICIEN";
    res.json(
      lieux.map(({ affectations, ...l }) => ({
        ...l,
        bornes: affectations.map((a) => a.borne),
        ca30jCents: voitCa ? (caParLieu.get(l.id)?.caTtcCents ?? 0) : null,
        ventes30j: voitCa ? (caParLieu.get(l.id)?.nbAcceptees ?? 0) : null,
      }))
    );
  })
);

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

// GET /api/lieux/:id — fiche complète
lieuxRouter.get(
  "/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    await verifierAccesLieu(req.utilisateur, Number(req.params.id));
    const lieu = await prisma.lieu.findUniqueOrThrow({
      where: { id: Number(req.params.id) },
      include: {
        typeLieu: true, sousType: true, standing: true, zoneGeo: true, tailleCommune: true,
        emplacementZone: true, eclairage: true, origineLead: true,
        commercial: { select: { id: true, nom: true, prenom: true } },
        contacts: { orderBy: { id: "asc" } },
        clienteles: { include: { refValeur: true } },
        horaires: { orderBy: [{ jourSemaine: "asc" }, { ouverture: "asc" }] },
        saisons: { orderBy: { debut: "desc" } },
        fermetures: { orderBy: { debut: "desc" } },
        affectations: {
          orderBy: { debut: "desc" },
          include: { borne: { include: { gamme: true } } },
        },
      },
    });

    res.json({
      ...lieu,
      horaires: lieu.horaires.map((h) => ({ ...h, ouverture: hhmm(h.ouverture), fermeture: hhmm(h.fermeture) })),
      clienteles: lieu.clienteles.map((c) => c.refValeur),
      affectations: lieu.affectations.map(({ borne, ...a }) => ({
        ...a,
        borne: { ...borne, apiKeyHash: undefined },
      })),
    });
  })
);

// ─── Écriture ───────────────────────────────────────────────

// POST /api/lieux
// Un commercial ne peut créer / modifier que ses propres lieux : il en reste le commercial responsable.
const commercialImpose = (req: UtilisateurRequest, champs: { commercialId?: number | null }) => {
  if (req.utilisateur?.role === "COMMERCIAL") champs.commercialId = req.utilisateur.id;
};

type Champs = ReturnType<typeof donneesLieu>["champs"];
type Avant = { adresse: string | null; codePostal: string | null; ville: string | null; latitude: Prisma.Decimal | null; longitude: Prisma.Decimal | null };

/**
 * Coordonnées pour la carte : celles saisies à la main sont gardées ; sinon (ou si
 * l'adresse a changé sans que la position soit retouchée) on géocode l'adresse.
 */
async function positionner(champs: Champs, avant?: Avant) {
  const fournies = champs.latitude != null && champs.longitude != null;
  const adresseChangee = !avant || (["adresse", "codePostal", "ville"] as const).some((k) => (champs[k] ?? null) !== (avant[k] ?? null));
  const retouchees =
    fournies && (!avant || Number(avant.latitude) !== champs.latitude || Number(avant.longitude) !== champs.longitude);
  if (fournies && (retouchees || !adresseChangee)) return;

  const p = await geocoder(champs);
  if (p) {
    champs.latitude = Math.round(p.latitude * 1e6) / 1e6;
    champs.longitude = Math.round(p.longitude * 1e6) / 1e6;
  } else if (fournies && adresseChangee) {
    // Ancienne position devenue fausse et nouvelle adresse introuvable : on retire le point
    champs.latitude = null;
    champs.longitude = null;
  }
}

lieuxRouter.post(
  "/",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { champs, clienteleIds, contacts, horaires, saisons, fermetures } = donneesLieu(lieuSchema.parse(req.body));
    commercialImpose(req, champs);
    await positionner(champs);
    const lieu = await prisma.lieu.create({
      data: {
        ...champs,
        clienteles: clienteleIds ? { create: clienteleIds.map((refValeurId) => ({ refValeurId })) } : undefined,
        contacts: contacts ? { create: contacts } : undefined,
        horaires: horaires ? { create: horaires } : undefined,
        saisons: saisons ? { create: saisons } : undefined,
        fermetures: fermetures ? { create: fermetures } : undefined,
      },
    });
    res.status(201).json(lieu);
  })
);

// PUT /api/lieux/:id — les sous-listes fournies remplacent les existantes
lieuxRouter.put(
  "/:id",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const { champs, clienteleIds, contacts, horaires, saisons, fermetures } = donneesLieu(lieuSchema.parse(req.body));
    commercialImpose(req, champs);
    await positionner(
      champs,
      await prisma.lieu.findUniqueOrThrow({
        where: { id: lieuId },
        select: { adresse: true, codePostal: true, ville: true, latitude: true, longitude: true },
      })
    );

    const lieu = await prisma.$transaction(async (db) => {
      if (clienteleIds) await db.lieuClientele.deleteMany({ where: { lieuId } });
      if (contacts) await db.lieuContact.deleteMany({ where: { lieuId } });
      if (horaires) await db.lieuHoraire.deleteMany({ where: { lieuId } });
      if (saisons) await db.lieuSaison.deleteMany({ where: { lieuId } });
      if (fermetures) await db.lieuFermeture.deleteMany({ where: { lieuId } });

      return db.lieu.update({
        where: { id: lieuId },
        data: {
          ...champs,
          clienteles: clienteleIds ? { create: clienteleIds.map((refValeurId) => ({ refValeurId })) } : undefined,
          contacts: contacts ? { create: contacts } : undefined,
          horaires: horaires ? { create: horaires } : undefined,
          saisons: saisons ? { create: saisons } : undefined,
          fermetures: fermetures ? { create: fermetures } : undefined,
        },
      });
    });
    res.json(lieu);
  })
);

// POST /api/lieux/geocoder — place sur la carte les lieux qui n'ont pas encore de coordonnées
lieuxRouter.post(
  "/geocoder",
  exiger("ADMIN"),
  asynchrone(async (_req, res) => {
    const lieux = await prisma.lieu.findMany({
      where: { OR: [{ latitude: null }, { longitude: null }] },
      select: { id: true, enseigne: true, adresse: true, codePostal: true, ville: true },
    });
    const introuvables: string[] = [];
    let places = 0;
    for (const l of lieux) {
      const p = await geocoder(l);
      if (!p) {
        introuvables.push(l.enseigne);
        continue;
      }
      await prisma.lieu.update({
        where: { id: l.id },
        data: { latitude: Math.round(p.latitude * 1e6) / 1e6, longitude: Math.round(p.longitude * 1e6) / 1e6 },
      });
      places++;
    }
    res.json({ places, introuvables });
  })
);
