import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { requirePerm } from "../middleware/permissions.js";
import { normaliserUid } from "../cartes/cartesLieu.js";

// Cartes sans contact du lieu (Mifare, avenant du 23/11/2026, docs/avenant-cartes-lieu.md) : enregistrement des cartes,
// solde, plafonds, désactivation, historique des utilisations et des mouvements. Monté sous /api/cartes-lieu.
export const cartesLieuRouter = Router();

const aujourdhui = () => jourEtHeureLocaux(new Date()).jour;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

type Etat = "active" | "expiree" | "desactivee";
const etat = (c: { desactiveLe: Date | null; expireLe: Date | null }): Etat =>
  c.desactiveLe ? "desactivee" : c.expireLe && c.expireLe < aujourdhui() ? "expiree" : "active";

const filtres = z.object({
  q: z.string().trim().optional(),
  lieuId: z.coerce.number().int().optional(),
  etat: z.enum(["active", "expiree", "desactivee"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

function where(f: z.infer<typeof filtres>): Prisma.CarteLieuWhereInput {
  const q = f.q?.toUpperCase().replace(/[\s:-]/g, "");
  const parEtat: Record<Etat, Prisma.CarteLieuWhereInput> = {
    active: { desactiveLe: null, OR: [{ expireLe: null }, { expireLe: { gte: aujourdhui() } }] },
    expiree: { desactiveLe: null, expireLe: { lt: aujourdhui() } },
    desactivee: { desactiveLe: { not: null } },
  };
  return {
    AND: [
      f.q ? { OR: [{ uid: { contains: q } }, { libelle: { contains: f.q, mode: "insensitive" } }] } : {},
      f.lieuId ? { lieuId: f.lieuId } : {},
      f.etat ? parEtat[f.etat] : {},
    ],
  };
}

// GET /api/cartes-lieu?q=&lieuId=&etat=&page= — 100 par page, les dernières créées d'abord
cartesLieuRouter.get(
  "/",
  asynchrone(async (req, res) => {
    const f = filtres.parse(req.query);
    const parPage = 100;
    const w = where(f);
    const [total, cartes] = await Promise.all([
      prisma.carteLieu.count({ where: w }),
      prisma.carteLieu.findMany({
        where: w,
        orderBy: { id: "desc" },
        skip: (f.page - 1) * parPage,
        take: parPage,
        include: {
          lieu: { select: { id: true, enseigne: true } },
          utilisations: { where: { accepte: true, annuleeLe: null }, orderBy: { horodatage: "desc" }, take: 1, select: { horodatage: true } },
          _count: { select: { utilisations: { where: { accepte: true, annuleeLe: null } } } },
        },
      }),
    ]);
    res.json({
      total,
      page: f.page,
      parPage,
      lignes: cartes.map(({ utilisations, _count, ...c }) => ({
        ...ligne(c),
        nbUtilisations: _count.utilisations,
        derniereUtilisation: utilisations[0]?.horodatage ?? null,
      })),
    });
  })
);

const ligne = (c: Prisma.CarteLieuGetPayload<{ include: { lieu: { select: { id: true; enseigne: true } } } }>) => ({
  id: c.id,
  uid: c.uid,
  libelle: c.libelle,
  effet: c.effet,
  soldeCents: c.soldeCents,
  plafondJourCents: c.plafondJourCents,
  plafondJourTirages: c.plafondJourTirages,
  expireLe: c.expireLe ? ymd(c.expireLe) : null,
  desactiveLe: c.desactiveLe,
  notes: c.notes,
  lieu: c.lieu,
  creeLe: c.createdAt,
  etat: etat(c),
});

// GET /api/cartes-lieu/inconnues?lieuId= — cartes présentées à une borne sans être enregistrées (30 derniers jours) :
// la façon simple de connaître l'UID d'une nouvelle carte, la présenter une fois à la borne du lieu.
cartesLieuRouter.get(
  "/inconnues",
  asynchrone(async (req, res) => {
    const { lieuId } = z.object({ lieuId: z.coerce.number().int().optional() }).parse(req.query);
    const depuis = new Date(Date.now() - 30 * 86_400_000);
    const lignes = await prisma.utilisationCarteLieu.findMany({
      where: { carteId: null, raison: "INCONNUE", uid: { not: null }, horodatage: { gte: depuis }, ...(lieuId ? { lieuId } : {}) },
      orderBy: { horodatage: "desc" },
      take: 500,
      select: { uid: true, typeCarte: true, horodatage: true, borne: { select: { id: true, identifiant: true } }, lieu: { select: { id: true, enseigne: true } } },
    });
    // Une carte enregistrée depuis ne figure plus dans la liste
    const enregistrees = new Set(
      (await prisma.carteLieu.findMany({ where: { uid: { in: [...new Set(lignes.map((l) => l.uid!))] } }, select: { uid: true } })).map((c) => c.uid)
    );
    const parUid = new Map<string, { uid: string; typeCarte: string | null; presentations: number; derniere: Date; borne: { id: number; identifiant: string }; lieu: { id: number; enseigne: string } | null }>();
    for (const l of lignes) {
      if (enregistrees.has(l.uid!)) continue;
      const p = parUid.get(l.uid!);
      if (p) p.presentations++;
      else parUid.set(l.uid!, { uid: l.uid!, typeCarte: l.typeCarte, presentations: 1, derniere: l.horodatage, borne: l.borne, lieu: l.lieu });
    }
    res.json([...parUid.values()]);
  })
);

const corpsCarte = z.object({
  libelle: z.string().trim().max(120).nullable().optional(),
  lieuId: z.number().int().positive(),
  effet: z.enum(["DEBITE", "OFFERT"]),
  plafondJourCents: z.number().int().min(1).max(1_000_000).nullable().optional(),
  plafondJourTirages: z.number().int().min(1).max(1000).nullable().optional(),
  expireLe: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

/** Champs d'une carte : le plafond qui ne correspond pas à l'effet est effacé */
const donnees = (d: z.infer<typeof corpsCarte>) => ({
  libelle: d.libelle || null,
  lieuId: d.lieuId,
  effet: d.effet,
  plafondJourCents: d.effet === "DEBITE" ? (d.plafondJourCents ?? null) : null,
  plafondJourTirages: d.effet === "OFFERT" ? (d.plafondJourTirages ?? null) : null,
  expireLe: d.expireLe ? new Date(`${d.expireLe}T00:00:00Z`) : null,
  notes: d.notes || null,
});

const uidValide = z.string().transform((v, ctx) => normaliserUid(v) ?? (ctx.addIssue({ code: "custom", message: "UID hexadécimal de 8, 14 ou 20 caractères" }), z.NEVER));

// POST /api/cartes-lieu { uid, lieuId, effet, libelle?, soldeInitialCents?, plafond…, expireLe?, notes? }
cartesLieuRouter.post(
  "/",
  requirePerm("cartes_lieu.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const d = corpsCarte.extend({ uid: uidValide, soldeInitialCents: z.number().int().min(0).max(1_000_000).optional() }).parse(req.body);
    await lieuExiste(d.lieuId);
    const solde = d.effet === "DEBITE" ? (d.soldeInitialCents ?? 0) : 0;
    try {
      const carte = await prisma.$transaction(async (db) => {
        const c = await db.carteLieu.create({ data: { ...donnees(d), uid: d.uid, soldeCents: solde, creeParId: req.utilisateur?.id ?? null } });
        if (solde > 0) await db.mouvementCarteLieu.create({ data: { carteId: c.id, montantCents: solde, soldeApresCents: solde, note: "Solde initial", parId: req.utilisateur?.id ?? null } });
        return c;
      });
      res.status(201).json({ id: carte.id });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new HttpError(409, "UID_EXISTANT", "Cette carte est déjà enregistrée.");
      throw e;
    }
  })
);

async function lieuExiste(lieuId: number) {
  if (!(await prisma.lieu.findFirst({ where: { id: lieuId, supprimeLe: null }, select: { id: true } }))) throw new HttpError(400, "LIEU_INCONNU", "Lieu introuvable.");
}

// GET /api/cartes-lieu/:id — la carte, ses 200 dernières utilisations (avec leur vente) et ses mouvements
cartesLieuRouter.get(
  "/:id",
  asynchrone(async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    const c = await prisma.carteLieu.findUnique({
      where: { id },
      include: { lieu: { select: { id: true, enseigne: true } }, creePar: { select: { prenom: true, nom: true } } },
    });
    if (!c) throw new HttpError(404, "INTROUVABLE");
    const [utilisations, mouvements, jour] = await Promise.all([
      prisma.utilisationCarteLieu.findMany({
        where: { carteId: id },
        orderBy: { horodatage: "desc" },
        take: 200,
        include: { borne: { select: { id: true, identifiant: true } }, lieu: { select: { id: true, enseigne: true } } },
      }),
      prisma.mouvementCarteLieu.findMany({ where: { carteId: id }, orderBy: { createdAt: "desc" }, take: 200, include: { par: { select: { prenom: true, nom: true } } } }),
      prisma.$queryRaw<{ cents: bigint | null; tirages: bigint | null }[]>`
        SELECT sum(montant_debite_cents) cents, sum(nb) tirages FROM utilisations_carte_lieu
        WHERE carte_id = ${id} AND accepte AND annulee_le IS NULL
          AND (horodatage AT TIME ZONE 'Europe/Paris')::date = ${ymd(aujourdhui())}::date`,
    ]);
    // Ventes envoyées par la borne avec carte_utilisation_id
    const ventes = utilisations.length
      ? await prisma.transaction.findMany({
          where: { OR: utilisations.map((u) => ({ borneId: u.borneId, carteUtilisationId: u.utilisationId })) },
          select: { id: true, borneId: true, carteUtilisationId: true, transactionIdModule: true, statut: true, montantTtcCents: true },
        })
      : [];
    res.json({
      ...ligne(c),
      creePar: c.creePar,
      aujourdhui: { cents: Number(jour[0]?.cents ?? 0), tirages: Number(jour[0]?.tirages ?? 0) },
      utilisations: utilisations.map((u) => ({
        id: String(u.id),
        horodatage: u.horodatage,
        borne: u.borne,
        lieu: u.lieu,
        utilisationId: u.utilisationId,
        sessionCode: u.sessionCode,
        evenementCode: u.evenementCode,
        montantCents: u.montantCents,
        nb: u.nb,
        accepte: u.accepte,
        effet: u.effet,
        montantDebiteCents: u.montantDebiteCents,
        soldeApresCents: u.soldeApresCents,
        raison: u.raison,
        annuleeLe: u.annuleeLe,
        annulationRaison: u.annulationRaison,
        ventes: ventes
          .filter((v) => v.borneId === u.borneId && v.carteUtilisationId === u.utilisationId)
          .map((v) => ({ id: String(v.id), transactionIdModule: v.transactionIdModule, statut: v.statut, montantTtcCents: v.montantTtcCents })),
      })),
      mouvements: mouvements.map((m) => ({ id: m.id, le: m.createdAt, montantCents: m.montantCents, soldeApresCents: m.soldeApresCents, note: m.note, par: m.par })),
    });
  })
);

// PATCH /api/cartes-lieu/:id — libellé, lieu, effet, plafonds, expiration, notes (le solde passe par /mouvement)
cartesLieuRouter.patch(
  "/:id",
  requirePerm("cartes_lieu.edit"),
  asynchrone(async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    const d = corpsCarte.parse(req.body);
    await lieuExiste(d.lieuId);
    const c = await prisma.carteLieu.findUnique({ where: { id }, select: { soldeCents: true } });
    if (!c) throw new HttpError(404, "INTROUVABLE");
    // Une carte qui garde du crédit ne devient pas « offert » : le solde serait perdu sans trace
    if (d.effet === "OFFERT" && c.soldeCents > 0) throw new HttpError(400, "SOLDE_RESTANT", "Retirez d'abord le solde restant de la carte avant de la passer en tirages offerts.");
    await prisma.carteLieu.update({ where: { id }, data: donnees(d) });
    res.json({ ok: true });
  })
);

// POST /api/cartes-lieu/:id/mouvement { montantCents (signé), note } — crédit (rechargement) ou retrait
cartesLieuRouter.post(
  "/:id/mouvement",
  requirePerm("cartes_lieu.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    const d = z
      .object({ montantCents: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "Montant non nul"), note: z.string().trim().max(500).nullable().optional() })
      .parse(req.body);
    const solde = await prisma.$transaction(async (db) => {
      const [verrou] = await db.$queryRaw<{ id: number }[]>`SELECT id FROM cartes_lieu WHERE id = ${id} FOR UPDATE`;
      if (!verrou) throw new HttpError(404, "INTROUVABLE");
      const c = await db.carteLieu.findUniqueOrThrow({ where: { id }, select: { effet: true, soldeCents: true } });
      if (c.effet !== "DEBITE") throw new HttpError(400, "CARTE_OFFERT", "Une carte de tirages offerts n'a pas de solde.");
      const apres = c.soldeCents + d.montantCents;
      if (apres < 0) throw new HttpError(400, "SOLDE_NEGATIF", "Le retrait dépasse le solde de la carte.");
      await db.carteLieu.update({ where: { id }, data: { soldeCents: apres } });
      await db.mouvementCarteLieu.create({ data: { carteId: id, montantCents: d.montantCents, soldeApresCents: apres, note: d.note || null, parId: req.utilisateur?.id ?? null } });
      return apres;
    });
    res.json({ soldeCents: solde });
  })
);

// POST /api/cartes-lieu/:id/desactiver { actif } — désactiver (carte perdue, copiée) ou réactiver
cartesLieuRouter.post(
  "/:id/desactiver",
  requirePerm("cartes_lieu.edit"),
  asynchrone(async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    const { actif } = z.object({ actif: z.boolean() }).parse(req.body);
    const r = await prisma.carteLieu.updateMany({ where: { id }, data: { desactiveLe: actif ? null : new Date() } });
    if (!r.count) throw new HttpError(404, "INTROUVABLE");
    res.json({ ok: true });
  })
);
