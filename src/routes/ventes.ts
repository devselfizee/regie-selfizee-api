import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { htDepuisTtc } from "../lib/montants.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { ajouterAuxAgregats } from "../ingestion/agregats.js";
import { sha256Payload } from "../ingestion/journal.js";
import { urlPhoto } from "../lib/photos.js";

// Recherche de ventes et remboursements (admin). La borne ne rembourse jamais :
// un remboursement est saisi ici, rattaché à la vente d'origine (avenant synchro, § 3.7).
export const ventesRouter = Router();

const jourIso = z.iso.date();

// Vraie vente : acceptée et débitée (ni gratuite, ni offerte, ni expirée…)
const VENDUE: Prisma.TransactionWhereInput = { statut: "ACCEPTEE", montantTtcCents: { gt: 0 }, moyenPaiement: { not: "AUCUN" } };
// Ce que montre la liste selon « type »
const TYPES: Record<string, Prisma.TransactionWhereInput> = {
  // Tous les paiements : chaque passage par un moyen de paiement (encaissé ou non) et les remboursements
  paiements: { moyenPaiement: { not: "AUCUN" } },
  ventes: { OR: [VENDUE, { statut: "REMBOURSEE" }] },
  non_abouties: { statut: { in: ["REFUSEE", "ANNULEE", "EXPIREE", "OFFERTE"] } },
  remboursements: { statut: "REMBOURSEE" },
  gratuites: { statut: "ACCEPTEE", OR: [{ moyenPaiement: "AUCUN" }, { montantTtcCents: 0 }] },
  tout: {},
};
const listeCodes = z
  .string()
  .regex(/^[A-Z_]+(,[A-Z_]+)*$/)
  .transform((s) => s.split(","))
  .optional();

// GET /api/ventes?q=&du=&au=&lieuId=&borneId=&type=&moyenPaiement=&parc=&page= — liste paginée des paiements
// (50 par page, les plus récents d'abord), avec le nombre total et l'encaissé de la sélection.
// Une recherche (q : identifiant de transaction, n° d'autorisation, identifiant Stripe) porte sur tout.
ventesRouter.get(
  "/",
  asynchrone(async (req, res) => {
    const f = z
      .object({
        q: z.string().trim().optional(),
        lieuId: z.coerce.number().int().optional(),
        borneId: z.coerce.number().int().optional(),
        du: jourIso.optional(),
        au: jourIso.optional(),
        type: z.enum(Object.keys(TYPES) as [string, ...string[]]).default("paiements"),
        moyenPaiement: listeCodes,
        parc: z.enum(["SELFIZEE", "CLIENT"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        // Compatibilité : tout=1 de l'ancienne page Ventes
        tout: z.string().optional(),
      })
      .parse(req.query);
    const type = f.tout ? "tout" : f.type;
    const where: Prisma.TransactionWhereInput = {
      AND: [
        f.q
          ? {
              OR: [
                { transactionIdModule: { contains: f.q, mode: "insensitive" } },
                { referenceMonetique: { contains: f.q, mode: "insensitive" } },
                // « j'ai été débité deux fois » : retrouver par les 4 derniers chiffres de la carte
                ...(/^\d{4}$/.test(f.q) ? [{ carteFin: f.q }] : []),
              ],
            }
          : TYPES[type],
        f.moyenPaiement?.length ? { moyenPaiement: { in: f.moyenPaiement as Prisma.EnumMoyenPaiementFilter["in"] } } : {},
        f.lieuId ? { lieuId: f.lieuId } : {},
        f.borneId ? { borneId: f.borneId } : {},
        // Une vente suit le parc du lieu (compte client) où elle a été faite
        f.parc ? { lieu: { parc: f.parc } } : {},
        f.du || f.au ? { jourLocal: { ...(f.du ? { gte: new Date(`${f.du}T00:00:00Z`) } : {}), ...(f.au ? { lte: new Date(`${f.au}T00:00:00Z`) } : {}) } } : {},
      ],
    };
    const parPage = 50;
    const [total, ventes, encaisse, rembourse] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { horodatage: "desc" },
        skip: (f.page - 1) * parPage,
        take: parPage,
        include: {
          borne: { select: { id: true, identifiant: true } },
          lieu: { select: { id: true, enseigne: true } },
          typeModule: { select: { libelle: true } },
          derivees: { where: { statut: "REMBOURSEE" }, select: { montantTtcCents: true } },
        },
      }),
      prisma.transaction.aggregate({ where: { AND: [where, VENDUE] }, _sum: { montantTtcCents: true }, _count: true }),
      prisma.transaction.aggregate({ where: { AND: [where, { statut: "REMBOURSEE" }] }, _sum: { montantTtcCents: true } }),
    ]);
    res.json({
      total,
      page: f.page,
      parPage,
      // Encaissé de la sélection : vraies ventes moins remboursements
      totaux: {
        nbVentes: encaisse._count,
        encaisseTtcCents: (encaisse._sum.montantTtcCents ?? 0) - (rembourse._sum.montantTtcCents ?? 0),
        rembourseTtcCents: rembourse._sum.montantTtcCents ?? 0,
      },
      lignes: ventes.map(({ derivees, ...v }) => ({
        ...v,
        id: v.id.toString(),
        importId: v.importId.toString(),
        transactionOrigineId: v.transactionOrigineId?.toString() ?? null,
        rembourseCents: derivees.reduce((s, r) => s + r.montantTtcCents, 0),
        photoUrl: urlPhoto(v.pikcloudUuid),
      })),
    });
  })
);

// GET /api/ventes/:id — récapitulatif d'une commande : le paiement, les autres paiements de la séance
// (« +1 pour un pote »), les remboursements, la photo et le parcours de l'invité
ventesRouter.get(
  "/:id",
  asynchrone(async (req, res) => {
    const v = await prisma.transaction.findUnique({
      where: { id: BigInt(req.params.id) },
      include: {
        borne: { select: { id: true, identifiant: true, gamme: { select: { libelle: true } } } },
        lieu: { select: { id: true, enseigne: true, ville: true, parc: true } },
        typeModule: { select: { libelle: true } },
        module: { select: { numeroSerie: true, identifiantPrestataire: true } },
        origine: { select: { id: true, transactionIdModule: true } },
        derivees: { where: { statut: "REMBOURSEE" }, orderBy: { horodatage: "asc" }, select: { id: true, horodatage: true, montantTtcCents: true } },
      },
    });
    if (!v) throw new HttpError(404, "INTROUVABLE");
    // Séance : l'identifiant sans son n° de paiement (S180-20261016-Z95FN7-1 → S180-20261016-Z95FN7)
    const seance = v.transactionIdModule.replace(/-RMB\d+$/, "").replace(/-\d+$/, "");
    const [paiementsSeance, parcours, motifs] = await Promise.all([
      prisma.transaction.findMany({
        where: { borneId: v.borneId, transactionIdModule: { startsWith: `${seance}-` }, statut: { not: "REMBOURSEE" } },
        orderBy: { horodatage: "asc" },
        select: { id: true, transactionIdModule: true, horodatage: true, statut: true, montantTtcCents: true, produitCode: true, produitLibelle: true, nbTirages: true, moyenPaiement: true },
      }),
      prisma.parcours.findUnique({
        where: { borneId_parcoursId: { borneId: v.borneId, parcoursId: seance } },
        select: { debut: true, fin: true, dureeS: true, issue: true, etapes: true, cadre: true, photos: true, tirages: true, photoUuid: true, evenement: true },
      }),
      // Motifs des remboursements (journal d'audit)
      v.derivees.length
        ? prisma.auditLog.findMany({ where: { entite: "transaction", entiteId: v.id.toString(), action: "REMBOURSEMENT" }, orderBy: { createdAt: "asc" }, select: { apres: true } })
        : Promise.resolve([]),
    ]);
    const photoUuid = v.pikcloudUuid ?? parcours?.photoUuid ?? null;
    res.json({
      ...v,
      id: v.id.toString(),
      importId: v.importId.toString(),
      transactionOrigineId: v.transactionOrigineId?.toString() ?? null,
      origine: v.origine ? { id: v.origine.id.toString(), transactionIdModule: v.origine.transactionIdModule } : null,
      remboursements: v.derivees.map((r, i) => ({
        id: r.id.toString(),
        horodatage: r.horodatage,
        montantTtcCents: r.montantTtcCents,
        motif: (motifs[i]?.apres as { motif?: string } | null)?.motif ?? null,
      })),
      derivees: undefined,
      rembourseCents: v.derivees.reduce((s, r) => s + r.montantTtcCents, 0),
      seance: { code: seance, paiements: paiementsSeance.map((p) => ({ ...p, id: p.id.toString() })) },
      parcours,
      photoUuid,
      photoUrl: urlPhoto(photoUuid),
    });
  })
);

// POST /api/ventes/:id/remboursement { montantCents?, motif } — total par défaut, partiel possible
ventesRouter.post(
  "/:id/remboursement",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const corps = z.object({ montantCents: z.number().int().positive().optional(), motif: z.string().trim().min(1).max(200) }).parse(req.body);
    const origine = await prisma.transaction.findUnique({
      where: { id: BigInt(req.params.id) },
      include: { borne: true, derivees: { where: { statut: "REMBOURSEE" }, select: { montantTtcCents: true } } },
    });
    if (!origine) throw new HttpError(404, "INTROUVABLE");
    if (origine.statut !== "ACCEPTEE" || origine.montantTtcCents === 0)
      throw new HttpError(400, "NON_REMBOURSABLE", "Seule une vente acceptée et payée peut être remboursée");
    const deja = origine.derivees.reduce((s, r) => s + r.montantTtcCents, 0);
    const reste = origine.montantTtcCents - deja;
    if (reste <= 0) throw new HttpError(400, "DEJA_REMBOURSE", "Cette vente est déjà entièrement remboursée");
    const montant = corps.montantCents ?? reste;
    if (montant > reste) throw new HttpError(400, "MONTANT_TROP_ELEVE", `Il reste ${(reste / 100).toFixed(2).replace(".", ",")} € remboursables sur cette vente`);

    const maintenant = new Date();
    const { jour, heure } = jourEtHeureLocaux(maintenant);
    const rang = origine.derivees.length + 1;
    const transactionIdModule = `${origine.transactionIdModule}-RMB${rang}`;
    const payload = { origine: origine.transactionIdModule, montantCents: montant, motif: corps.motif, par: req.utilisateur?.email };

    const cree = await prisma.$transaction(async (db) => {
      const lot = await db.importLot.create({
        data: {
          source: "BACKOFFICE",
          type: "TRANSACTIONS",
          borneId: origine.borneId,
          borneIdentifiant: origine.borne.identifiant,
          payloadSha256: sha256Payload(payload),
          payload,
          statut: "OK",
          nbRecues: 1,
          nbCreees: 1,
        },
      });
      const r = await db.transaction.create({
        data: {
          borneId: origine.borneId,
          transactionIdModule,
          // Même lieu que la vente : le remboursement se déduit de sa base de commission
          lieuId: origine.lieuId,
          affectationId: origine.affectationId,
          horodatage: maintenant,
          offsetMinutes: 0,
          jourLocal: jour,
          montantTtcCents: montant,
          tauxTvaBp: origine.tauxTvaBp,
          montantHtCents: htDepuisTtc(montant, origine.tauxTvaBp),
          devise: origine.devise,
          statut: "REMBOURSEE",
          typeModuleId: origine.typeModuleId,
          moduleId: origine.moduleId,
          moyenPaiement: origine.moyenPaiement,
          produitCode: origine.produitCode,
          produitLibelle: origine.produitLibelle,
          nbTirages: 0,
          transactionOrigineId: origine.id,
          logicielVersion: "back-office",
          importId: lot.id,
          // Un remboursement par carte apparaît sur le relevé (débit) : à rapprocher comme la vente
          rapprochement: origine.rapprochement === "NON_APPLICABLE" ? "NON_APPLICABLE" : "NON_RAPPROCHE",
        },
      });
      if (r.lieuId !== null) {
        await ajouterAuxAgregats(db, [
          {
            jour, heure, lieuId: r.lieuId, borneId: r.borneId, typeModuleId: r.typeModuleId, moyenPaiement: r.moyenPaiement,
            statut: r.statut, montantTtcCents: r.montantTtcCents, montantHtCents: r.montantHtCents, nbTirages: 0,
          },
        ]);
      }
      await db.auditLog.create({
        data: { userId: req.utilisateur?.id ?? null, entite: "transaction", entiteId: origine.id.toString(), action: "REMBOURSEMENT", apres: payload },
      });
      return r;
    });
    res.status(201).json({ id: cree.id.toString(), transactionId: cree.transactionIdModule, montantCents: montant });
  })
);
