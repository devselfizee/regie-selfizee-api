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
import { requirePerm } from "../middleware/permissions.js";

// Recherche de ventes et remboursements (admin). La borne ne rembourse jamais :
// un remboursement est saisi ici, rattaché à la vente d'origine (avenant synchro, § 3.7).
export const ventesRouter = Router();

const jourIso = z.iso.date();

// Vraie vente : acceptée et débitée (ni gratuite, ni offerte, ni expirée…)
const VENDUE: Prisma.TransactionWhereInput = { statut: "ACCEPTEE", montantTtcCents: { gt: 0 }, moyenPaiement: { not: "AUCUN" } };
// Ce que montre la liste selon « type »
// Séance sans action : photo validée sans paiement (mode gratuit, code staff, sans tirage…), pas une vente
const SANS_ACTION: Prisma.TransactionWhereInput = { statut: "ACCEPTEE", OR: [{ moyenPaiement: "AUCUN" }, { montantTtcCents: 0 }] };
const TYPES: Record<string, Prisma.TransactionWhereInput> = {
  // Tous les paiements : chaque passage par un moyen de paiement (encaissé ou non) et les remboursements
  paiements: { moyenPaiement: { not: "AUCUN" }, NOT: SANS_ACTION },
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

const filtresListe = z.object({
  q: z.string().trim().optional(),
  lieuId: z.coerce.number().int().optional(),
  borneId: z.coerce.number().int().optional(),
  du: jourIso.optional(),
  au: jourIso.optional(),
  type: z.enum(Object.keys(TYPES) as [string, ...string[]]).default("paiements"),
  moyenPaiement: listeCodes,
  parc: z.enum(["SELFIZEE", "CLIENT"]).optional(),
  cartes: z.enum(["reelles", "test", "toutes"]).default("reelles"),
  // 1 : ajoute les photos validées sans paiement (retour de Sébastien : elles n'ont rien à faire dans les ventes)
  sansAction: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Compatibilité : tout=1 de l'ancienne page Ventes
  tout: z.string().optional(),
});

/** Conditions de la liste ; sansType : sans le filtre « Afficher » (synthèse par jour, qui compte chaque catégorie) */
function whereListe(f: z.infer<typeof filtresListe>, sansType = false): Prisma.TransactionWhereInput {
  const type = f.tout ? "tout" : f.type;
  return {
    AND: [
      sansType
        ? {}
        : f.q
          ? {
              OR: [
                { transactionIdModule: { contains: f.q, mode: "insensitive" } },
                { referenceMonetique: { contains: f.q, mode: "insensitive" } },
                // « j'ai été débité deux fois » : retrouver par les 4 derniers chiffres de la carte
                ...(/^d{4}$/.test(f.q) ? [{ carteFin: f.q }] : []),
              ],
            }
          : f.sansAction === "1" && type !== "tout"
            ? { OR: [TYPES[type], SANS_ACTION] }
            : TYPES[type],
      f.moyenPaiement?.length ? { moyenPaiement: { in: f.moyenPaiement as Prisma.EnumMoyenPaiementFilter["in"] } } : {},
      f.lieuId ? { lieuId: f.lieuId } : {},
      f.borneId ? { borneId: f.borneId } : {},
      // Une vente suit le parc du lieu (compte client) où elle a été faite
      f.parc ? { lieu: { parc: f.parc } } : {},
      // Une recherche trouve aussi les ventes de test
      (f.q && !sansType) || f.cartes === "toutes" ? {} : { test: f.cartes === "test" },
      f.du || f.au ? { jourLocal: { ...(f.du ? { gte: new Date(`${f.du}T00:00:00Z`) } : {}), ...(f.au ? { lte: new Date(`${f.au}T00:00:00Z`) } : {}) } } : {},
    ],
  };
}

// GET /api/ventes/par-jour?du=&au=&<filtres> — vue calendrier (retour de Sébastien) : la synthèse de chaque jour
// (ventes encaissées, remboursements, paiements non aboutis, séances sans action), quel que soit « Afficher »
ventesRouter.get(
  "/par-jour",
  asynchrone(async (req, res) => {
    const f = filtresListe.parse(req.query);
    if (!f.du || !f.au) throw new HttpError(400, "PERIODE_REQUISE", "du et au sont requis");
    const where = whereListe(f, true);
    const [ventes, remboursements, nonAbouties, sansAction] = await Promise.all([
      prisma.transaction.groupBy({ by: ["jourLocal"], where: { AND: [where, VENDUE] }, _count: true, _sum: { montantTtcCents: true, montantHtCents: true } }),
      prisma.transaction.groupBy({ by: ["jourLocal"], where: { AND: [where, { statut: "REMBOURSEE" }] }, _sum: { montantTtcCents: true, montantHtCents: true } }),
      prisma.transaction.groupBy({ by: ["jourLocal"], where: { AND: [where, TYPES.non_abouties] }, _count: true }),
      prisma.transaction.groupBy({ by: ["jourLocal"], where: { AND: [where, SANS_ACTION] }, _count: true }),
    ]);
    const jours = new Map<string, { jour: string; nbVentes: number; encaisseTtcCents: number; encaisseHtCents: number; rembourseTtcCents: number; rembourseHtCents: number; nbNonAbouties: number; nbSansAction: number }>();
    const ligne = (d: Date) => {
      const jour = d.toISOString().slice(0, 10);
      const l = jours.get(jour) ?? { jour, nbVentes: 0, encaisseTtcCents: 0, encaisseHtCents: 0, rembourseTtcCents: 0, rembourseHtCents: 0, nbNonAbouties: 0, nbSansAction: 0 };
      jours.set(jour, l);
      return l;
    };
    for (const v of ventes) Object.assign(ligne(v.jourLocal), { nbVentes: v._count, encaisseTtcCents: v._sum.montantTtcCents ?? 0, encaisseHtCents: v._sum.montantHtCents ?? 0 });
    for (const r of remboursements) Object.assign(ligne(r.jourLocal), { rembourseTtcCents: r._sum.montantTtcCents ?? 0, rembourseHtCents: r._sum.montantHtCents ?? 0 });
    for (const x of nonAbouties) ligne(x.jourLocal).nbNonAbouties = x._count;
    for (const x of sansAction) ligne(x.jourLocal).nbSansAction = x._count;
    res.json([...jours.values()].sort((a, b) => a.jour.localeCompare(b.jour)));
  })
);

// GET /api/ventes?q=&du=&au=&lieuId=&borneId=&type=&moyenPaiement=&parc=&cartes=&page= — liste paginée des paiements
// (50 par page, les plus récents d'abord), avec le nombre total et l'encaissé de la sélection.
// Une recherche (q : identifiant de transaction, n° d'autorisation, identifiant Stripe) porte sur tout.
// cartes : reelles (par défaut, sans les cartes de test), test (seulement elles) ou toutes.
ventesRouter.get(
  "/",
  asynchrone(async (req, res) => {
    const f = filtresListe.parse(req.query);
    const where = whereListe(f);
    const parPage = 50;
    const [total, ventes, encaisse, rembourse, cartesTest] = await Promise.all([
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
          derivees: { where: { statut: "REMBOURSEE" }, select: { montantTtcCents: true, montantHtCents: true } },
        },
      }),
      prisma.transaction.aggregate({ where: { AND: [where, VENDUE] }, _sum: { montantTtcCents: true, montantHtCents: true }, _count: true }),
      prisma.transaction.aggregate({ where: { AND: [where, { statut: "REMBOURSEE" }] }, _sum: { montantTtcCents: true, montantHtCents: true } }),
      prisma.carteTest.findMany({ select: { derniersChiffres: true, nom: true } }),
    ]);
    const nomCarte = new Map(cartesTest.map((c) => [c.derniersChiffres, c.nom]));
    res.json({
      total,
      page: f.page,
      parPage,
      // Encaissé de la sélection : vraies ventes moins remboursements
      totaux: {
        nbVentes: encaisse._count,
        encaisseTtcCents: (encaisse._sum.montantTtcCents ?? 0) - (rembourse._sum.montantTtcCents ?? 0),
        rembourseTtcCents: rembourse._sum.montantTtcCents ?? 0,
        encaisseHtCents: (encaisse._sum.montantHtCents ?? 0) - (rembourse._sum.montantHtCents ?? 0),
        rembourseHtCents: rembourse._sum.montantHtCents ?? 0,
      },
      lignes: ventes.map(({ derivees, ...v }) => ({
        ...v,
        id: v.id.toString(),
        importId: v.importId.toString(),
        transactionOrigineId: v.transactionOrigineId?.toString() ?? null,
        rembourseCents: derivees.reduce((s, r) => s + r.montantTtcCents, 0),
        rembourseHtCents: derivees.reduce((s, r) => s + r.montantHtCents, 0),
        photoUrl: urlPhoto(v.pikcloudUuid),
        carteTest: v.test && v.carteFin ? (nomCarte.get(v.carteFin) ?? "Carte de test") : null,
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
    const carteTest = v.test && v.carteFin ? await prisma.carteTest.findUnique({ where: { derniersChiffres: v.carteFin }, select: { nom: true } }) : null;
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
      carteTest: v.test ? (carteTest?.nom ?? "Carte de test") : null,
    });
  })
);

// POST /api/ventes/:id/remboursement { montantCents?, motif } — total par défaut, partiel possible
ventesRouter.post(
  "/:id/remboursement",
  requirePerm("paiements.rembourser"),
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
          // Remboursement d'une vente de test : de test aussi
          test: origine.test,
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
            statut: r.statut, montantTtcCents: r.montantTtcCents, montantHtCents: r.montantHtCents, nbTirages: 0, test: r.test,
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
