import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { envoyerClasseur, type Colonne } from "../lib/excel.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { creerCodes, libelleRemise } from "../codes/codes.js";
import { requirePerm } from "../middleware/permissions.js";

// Codes de remise (demande de Sébastien, 02/11/2026) : génération par lots, liste, détail des utilisations, export.
export const codesRemiseRouter = Router();

const filtres = z.object({
  q: z.string().trim().optional(),
  lieuId: z.coerce.number().int().optional(),
  lotId: z.coerce.number().int().optional(),
  // a_utiliser : jamais utilisé ; entame : utilisé en partie ; epuise ; expire ; desactive
  statut: z.enum(["a_utiliser", "entame", "epuise", "expire", "desactive"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

const aujourdhui = () => jourEtHeureLocaux(new Date()).jour;

function where(f: z.infer<typeof filtres>): Prisma.CodeRemiseWhereInput {
  const actif = { desactiveLe: null, lot: { expireLe: { gte: aujourdhui() } } };
  const statut: Record<string, Prisma.CodeRemiseWhereInput> = {
    a_utiliser: { ...actif, utilise: 0 },
    // utilisé en partie / entièrement : comparé à la quantité du lot (filtré après lecture pour « entame » / « epuise »)
    entame: { ...actif, utilise: { gt: 0 } },
    epuise: { utilise: { gt: 0 } },
    expire: { desactiveLe: null, lot: { expireLe: { lt: aujourdhui() } } },
    desactive: { desactiveLe: { not: null } },
  };
  return {
    AND: [
      f.q ? { code: { contains: f.q.toUpperCase().replace(/[\s-]/g, "") } } : {},
      f.lieuId ? { lot: { lieuId: f.lieuId } } : {},
      f.lotId ? { lotId: f.lotId } : {},
      f.statut ? statut[f.statut] : {},
    ],
  };
}

const inclure = {
  lot: { include: { lieu: { select: { id: true, enseigne: true } } } },
  utilisations: { orderBy: { horodatage: "desc" as const }, take: 1, select: { horodatage: true } },
  _count: { select: { utilisations: true } },
} satisfies Prisma.CodeRemiseInclude;
type CodeListe = Prisma.CodeRemiseGetPayload<{ include: typeof inclure }>;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const etat = (c: CodeListe) =>
  c.desactiveLe ? "desactive" : c.lot.expireLe < aujourdhui() ? "expire" : c.utilise >= c.lot.quantite ? "epuise" : c.utilise > 0 ? "entame" : "a_utiliser";

const ligne = (c: CodeListe) => ({
  id: c.id,
  code: c.code,
  lotId: c.lotId,
  libelle: c.lot.libelle,
  type: c.lot.type,
  pourcentage: c.lot.pourcentage,
  quantite: c.lot.quantite,
  utilise: c.utilise,
  restant: Math.max(0, c.lot.quantite - c.utilise),
  lieu: c.lot.lieu,
  seulementLieu: c.lot.seulementLieu,
  expireLe: ymd(c.lot.expireLe),
  creeLe: c.lot.createdAt,
  desactiveLe: c.desactiveLe,
  etat: etat(c),
  nbUtilisations: c._count.utilisations,
  derniereUtilisation: c.utilisations[0]?.horodatage ?? null,
});

/** Codes filtrés ; « entame » et « epuise » se départagent sur la quantité du lot */
async function chercher(f: z.infer<typeof filtres>, pagination?: { skip: number; take: number }) {
  const codes = await prisma.codeRemise.findMany({ where: where(f), include: inclure, orderBy: [{ lotId: "desc" }, { code: "asc" }] });
  const tous = codes.map(ligne).filter((l) => !f.statut || f.statut === "expire" || f.statut === "desactive" || l.etat === f.statut);
  return {
    total: tous.length,
    lignes: pagination ? tous.slice(pagination.skip, pagination.skip + pagination.take) : tous,
    // Tous les codes du filtre, pour « tout sélectionner » au-delà de la page affichée
    ids: tous.map((l) => l.id),
  };
}

// GET /api/codes-remise?q=&lieuId=&lotId=&statut=&page= — 100 par page, les derniers lots d'abord
codesRemiseRouter.get(
  "/",
  asynchrone(async (req, res) => {
    const f = filtres.parse(req.query);
    const parPage = 100;
    const [r, lots] = await Promise.all([
      chercher(f, { skip: (f.page - 1) * parPage, take: parPage }),
      prisma.lotCodesRemise.findMany({ orderBy: { id: "desc" }, select: { id: true, libelle: true, nbCodes: true, createdAt: true, lieu: { select: { enseigne: true } } } }),
    ]);
    res.json({ ...r, page: f.page, parPage, lots });
  })
);

// GET /api/codes-remise/export.xlsx?<filtres> — tous les codes filtrés
codesRemiseRouter.get(
  "/export.xlsx",
  asynchrone(async (req, res) => {
    const f = filtres.parse(req.query);
    const { lignes } = await chercher(f);
    type L = (typeof lignes)[number];
    const ETATS: Record<string, string> = { a_utiliser: "À utiliser", entame: "Utilisé en partie", epuise: "Épuisé", expire: "Expiré", desactive: "Désactivé" };
    const colonnes: Colonne<L>[] = [
      { entete: "Code", valeur: (l) => l.code },
      { entete: "Remise", valeur: (l) => (l.type === "OFFERT" ? "Impressions offertes" : `${l.pourcentage} % de remise`), largeur: 20 },
      { entete: "Impressions", valeur: (l) => l.quantite, format: "nombre" },
      { entete: "Utilisées", valeur: (l) => l.utilise, format: "nombre" },
      { entete: "Restantes", valeur: (l) => l.restant, format: "nombre" },
      { entete: "État", valeur: (l) => ETATS[l.etat], largeur: 16 },
      { entete: "Lieu", valeur: (l) => l.lieu?.enseigne ?? "", largeur: 24 },
      { entete: "Valable", valeur: (l) => (l.seulementLieu && l.lieu ? "Ce lieu seulement" : "Toutes les bornes"), largeur: 18 },
      { entete: "Expire le", valeur: (l) => new Date(`${l.expireLe}T00:00:00Z`), format: "date" },
      { entete: "Utilisations", valeur: (l) => l.nbUtilisations, format: "nombre" },
      { entete: "Dernière utilisation", valeur: (l) => l.derniereUtilisation, format: "dateHeure", largeur: 18 },
      { entete: "Lot", valeur: (l) => `#${l.lotId}${l.libelle ? ` ${l.libelle}` : ""}`, largeur: 24 },
    ];
    await envoyerClasseur(res, `codes-remise_${ymd(aujourdhui())}.xlsx`, "Codes", colonnes, lignes);
  })
);

// GET /api/codes-remise/lots?lieuId= — lots donnés à un lieu, résumés (fiche du lieu, onglet Informations)
codesRemiseRouter.get(
  "/lots",
  asynchrone(async (req, res) => {
    const { lieuId } = z.object({ lieuId: z.coerce.number().int().positive() }).parse(req.query);
    const lots = await prisma.lotCodesRemise.findMany({
      where: { lieuId },
      orderBy: { id: "desc" },
      include: { creePar: { select: { prenom: true, nom: true } }, codes: { select: { utilise: true, desactiveLe: true } } },
    });
    res.json(
      lots.map(({ codes, ...l }) => ({
        id: l.id,
        libelle: l.libelle,
        remise: libelleRemise(l),
        seulementLieu: l.seulementLieu,
        expireLe: ymd(l.expireLe),
        expire: l.expireLe < aujourdhui(),
        creeLe: l.createdAt,
        creePar: l.creePar,
        nbCodes: codes.length,
        // Codes déjà saisis au moins une fois, et impressions encore disponibles sur les codes actifs
        codesUtilises: codes.filter((c) => c.utilise > 0).length,
        codesDesactives: codes.filter((c) => c.desactiveLe).length,
        impressionsRestantes: codes.filter((c) => !c.desactiveLe).reduce((s, c) => s + Math.max(0, l.quantite - c.utilise), 0),
      }))
    );
  })
);

// GET /api/codes-remise/:id — un code et toutes ses utilisations (borne, lieu, date)
codesRemiseRouter.get(
  "/:id",
  asynchrone(async (req, res) => {
    const c = await prisma.codeRemise.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        ...inclure,
        lot: { include: { lieu: { select: { id: true, enseigne: true } }, creePar: { select: { prenom: true, nom: true } } } },
        // Code gagné à la carte à gratter de la page souvenir : la séance d'où il vient (sans l'e-mail de l'invité)
        carteSouvenir: {
          select: {
            createdAt: true, reveleeLe: true,
            inscription: { select: { codeEvent: true, photoUuid: true, lieu: { select: { id: true, enseigne: true } }, evenement: { select: { nom: true, habituel: true } } } },
          },
        },
      },
    });
    if (!c) throw new HttpError(404, "INTROUVABLE");
    const utilisations = await prisma.utilisationCodeRemise.findMany({
      where: { codeId: c.id },
      orderBy: { horodatage: "desc" },
      include: { borne: { select: { id: true, identifiant: true } }, lieu: { select: { id: true, enseigne: true } } },
    });
    // Quand et comment le code a été généré (retour de Sébastien du 13/11)
    const carte = c.carteSouvenir;
    const origine = carte
      ? {
          type: "carte_a_gratter" as const,
          // La carte (et son code) est tirée à l'affichage de la page souvenir, puis grattée par l'invité
          le: carte.createdAt,
          grattee: carte.reveleeLe,
          codeEvent: carte.inscription.codeEvent,
          evenement: carte.inscription.evenement ? (carte.inscription.evenement.habituel ? "Habituel" : carte.inscription.evenement.nom) : null,
          lieu: carte.inscription.lieu,
          photoUuid: carte.inscription.photoUuid,
        }
      : { type: "manuel" as const, le: c.lot.createdAt, par: c.lot.creePar, nbCodes: c.lot.nbCodes };
    res.json({ ...ligne(c), origine, utilisations: utilisations.map((u) => ({ ...u, id: u.id.toString() })) });
  })
);

const corpsLot = z
  .object({
    nbCodes: z.number().int().min(1).max(1000),
    libelle: z.string().trim().max(120).optional(),
    type: z.enum(["OFFERT", "POURCENTAGE"]),
    quantite: z.number().int().min(1).max(100),
    pourcentage: z.number().int().min(1).max(99).optional(),
    lieuId: z.number().int().nullable().optional(),
    seulementLieu: z.boolean().default(false),
    expireLe: z.iso.date(),
  })
  .refine((d) => d.type !== "POURCENTAGE" || d.pourcentage !== undefined, { message: "Pourcentage de remise attendu", path: ["pourcentage"] })
  .refine((d) => !d.seulementLieu || !!d.lieuId, { message: "Choisir le lieu pour un code valable dans ce lieu seulement", path: ["lieuId"] });

// POST /api/codes-remise/lots — génère un lot de codes (1 à 1000) aux mêmes conditions
codesRemiseRouter.post(
  "/lots",
  requirePerm("codes_remise.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const d = corpsLot.parse(req.body);
    if (new Date(`${d.expireLe}T00:00:00Z`) < aujourdhui()) throw new HttpError(400, "DATE_PASSEE", "La date de fin de validité est passée");
    const lot = await prisma.lotCodesRemise.create({
      data: {
        libelle: d.libelle || null,
        type: d.type,
        quantite: d.quantite,
        pourcentage: d.type === "POURCENTAGE" ? d.pourcentage! : null,
        lieuId: d.lieuId ?? null,
        seulementLieu: d.seulementLieu,
        expireLe: new Date(`${d.expireLe}T00:00:00Z`),
        nbCodes: d.nbCodes,
        creeParId: req.utilisateur?.id ?? null,
      },
    });
    const crees = await creerCodes(lot.id, d.nbCodes);
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "lot_codes_remise", entiteId: String(lot.id), action: "CREATION", apres: d } });
    res.status(201).json({ lotId: lot.id, codesCrees: crees });
  })
);

// POST /api/codes-remise/supprimer { ids } — supprime des codes jamais utilisés (lot créé par erreur…).
// Un code déjà utilisé reste (son historique compte) : on le désactive à la place. Les lots vidés disparaissent.
codesRemiseRouter.post(
  "/supprimer",
  requirePerm("codes_remise.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(5000) }).parse(req.body);
    const codes = await prisma.codeRemise.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, lotId: true, utilise: true, lot: { select: { lieuId: true } }, _count: { select: { utilisations: true } } },
    });
    const utilises = codes.filter((c) => c.utilise > 0 || c._count.utilisations > 0);
    if (utilises.length) {
      const liste = utilises.slice(0, 5).map((c) => c.code).join(", ") + (utilises.length > 5 ? "…" : "");
      throw new HttpError(
        409,
        "CODES_UTILISES",
        `${utilises.length} code${utilises.length > 1 ? "s ont" : " a"} déjà servi (${liste}) : ${utilises.length > 1 ? "ils restent" : "il reste"} pour l'historique. Désactivez-${utilises.length > 1 ? "les" : "le"} plutôt, et retirez-${utilises.length > 1 ? "les" : "le"} de la sélection.`
      );
    }
    const lotIds = [...new Set(codes.map((c) => c.lotId))];
    const lotsSupprimes = await prisma.$transaction(async (tx) => {
      await tx.codeRemise.deleteMany({ where: { id: { in: codes.map((c) => c.id) } } });
      const vides = await tx.lotCodesRemise.findMany({ where: { id: { in: lotIds }, codes: { none: {} } }, select: { id: true } });
      await tx.lotCodesRemise.deleteMany({ where: { id: { in: vides.map((l) => l.id) } } });
      await tx.auditLog.createMany({
        data: lotIds.map((lotId) => ({
          userId: req.utilisateur?.id ?? null,
          entite: "lot_codes_remise",
          entiteId: String(lotId),
          action: "SUPPRESSION_CODES",
          // lieuId : la suppression apparaît dans la timeline du lieu, même quand le lot n'existe plus
          avant: {
            lieuId: codes.find((c) => c.lotId === lotId)?.lot.lieuId ?? null,
            codes: codes.filter((c) => c.lotId === lotId).map((c) => c.code),
            lotSupprime: vides.some((l) => l.id === lotId),
          },
        })),
      });
      return vides.length;
    });
    res.json({ supprimes: codes.length, lotsSupprimes });
  })
);

// POST /api/codes-remise/:id/desactiver { actif: false | true } — retirer un code (perdu, diffusé par erreur) ou le remettre
codesRemiseRouter.post(
  "/:id/desactiver",
  requirePerm("codes_remise.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { actif } = z.object({ actif: z.boolean() }).parse(req.body);
    const c = await prisma.codeRemise.update({ where: { id: Number(req.params.id) }, data: { desactiveLe: actif ? null : new Date() } });
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "code_remise", entiteId: String(c.id), action: actif ? "REACTIVATION" : "DESACTIVATION" } });
    res.json({ id: c.id, desactiveLe: c.desactiveLe });
  })
);
