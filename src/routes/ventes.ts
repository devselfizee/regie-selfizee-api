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

// Recherche de ventes et remboursements (admin). La borne ne rembourse jamais :
// un remboursement est saisi ici, rattaché à la vente d'origine (avenant synchro, § 3.7).
export const ventesRouter = Router();

const jourIso = z.iso.date();

// GET /api/ventes?q=&borneId=&du=&au= — 100 ventes au plus, les plus récentes d'abord
ventesRouter.get(
  "/",
  asynchrone(async (req, res) => {
    const f = z
      .object({ q: z.string().trim().optional(), borneId: z.coerce.number().int().optional(), du: jourIso.optional(), au: jourIso.optional() })
      .parse(req.query);
    const where: Prisma.TransactionWhereInput = {
      ...(f.q ? { OR: [{ transactionIdModule: { contains: f.q, mode: "insensitive" } }, { referenceMonetique: { contains: f.q, mode: "insensitive" } }] } : {}),
      ...(f.borneId ? { borneId: f.borneId } : {}),
      ...(f.du || f.au ? { jourLocal: { ...(f.du ? { gte: new Date(`${f.du}T00:00:00Z`) } : {}), ...(f.au ? { lte: new Date(`${f.au}T00:00:00Z`) } : {}) } } : {}),
    };
    const ventes = await prisma.transaction.findMany({
      where,
      orderBy: { horodatage: "desc" },
      take: 100,
      include: {
        borne: { select: { id: true, identifiant: true } },
        lieu: { select: { id: true, enseigne: true } },
        typeModule: { select: { libelle: true } },
        derivees: { where: { statut: "REMBOURSEE" }, select: { montantTtcCents: true } },
      },
    });
    res.json(
      ventes.map(({ derivees, ...v }) => ({
        ...v,
        id: v.id.toString(),
        importId: v.importId.toString(),
        transactionOrigineId: v.transactionOrigineId?.toString() ?? null,
        rembourseCents: derivees.reduce((s, r) => s + r.montantTtcCents, 0),
      }))
    );
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
