import { Router } from "express";
import {
  BaseCalcul, ModeleCommission, PaliersMode, Periodicite, Prisma, ReversementStatut, SeuilCumul, SeuilMode,
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, perimetreLieux, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { calculerPeriode, decrireContrat, type RegleContrat } from "../commissions/moteur.js";
import { estDebutDePeriode } from "../commissions/periodes.js";
import { calculerReversements, commissionEnCours, regleDe, STATUTS_FIGES } from "../commissions/service.js";
import { chargerReleve, destinatairesParDefaut, detailDe, genererPdfReleve, nomFichierReleve, type Releve } from "../commissions/releve.js";
import { emailConfigure, envoyerEmail } from "../lib/envoi.js";

export const commissionsRouter = Router();
export const reversementsRouter = Router();

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const entier = z.number().int().min(0);

// ─── Contrats ───────────────────────────────────────────────

const contratSchema = z
  .object({
    modele: z.enum(ModeleCommission),
    base: z.enum(BaseCalcul).default("TTC"),
    netRemboursements: z.boolean().default(true),
    periodicite: z.enum(Periodicite).default("MOIS"),
    dateEffet: z.iso.date().transform((v) => new Date(`${v}T00:00:00Z`)),
    tauxBp: entier.max(10000).nullable().optional(),
    seuilCents: entier.nullable().optional(),
    seuilMode: z.enum(SeuilMode).nullable().optional(),
    seuilCumul: z.enum(SeuilCumul).nullable().optional(),
    forfaitCents: entier.nullable().optional(),
    minimumGarantiCents: entier.nullable().optional(),
    paliersMode: z.enum(PaliersMode).nullable().optional(),
    paliers: z.array(z.object({ depuisCents: entier, tauxBp: entier.max(10000) })).default([]),
    motifAvenant: z.string().trim().nullable().optional(),
  })
  .superRefine((c, ctx) => {
    const manque = (champ: string, message: string) => ctx.addIssue({ code: "custom", path: [champ], message });
    if (c.modele === "POURCENTAGE" && !c.tauxBp) manque("tauxBp", "Taux obligatoire");
    if (c.modele === "POURCENTAGE_APRES_SEUIL") {
      if (!c.tauxBp) manque("tauxBp", "Taux obligatoire");
      if (!c.seuilCents) manque("seuilCents", "Seuil obligatoire");
    }
    if (c.modele === "PALIERS") {
      if (!c.paliers.length) manque("paliers", "Au moins un palier");
      if (new Set(c.paliers.map((p) => p.depuisCents)).size !== c.paliers.length) manque("paliers", "Deux paliers ont la même borne");
    }
    if (c.modele === "FORFAIT" && !c.forfaitCents) manque("forfaitCents", "Montant du forfait obligatoire");
    if (!estDebutDePeriode(c.dateEffet, c.periodicite)) {
      manque("dateEffet", "La date d'effet doit être le premier jour d'une période (mois, trimestre ou année)");
    }
  });

/** Ne garde que les champs utiles au modèle (évite les paramètres fantômes). */
function normaliser(c: z.infer<typeof contratSchema>) {
  const m = c.modele;
  return {
    modele: m,
    base: c.base,
    netRemboursements: c.netRemboursements,
    periodicite: c.periodicite,
    dateEffet: c.dateEffet,
    tauxBp: m === "POURCENTAGE" || m === "POURCENTAGE_APRES_SEUIL" || m === "FORFAIT" ? c.tauxBp ?? null : null,
    seuilCents: m === "POURCENTAGE_APRES_SEUIL" ? c.seuilCents ?? null : null,
    seuilMode: m === "POURCENTAGE_APRES_SEUIL" ? c.seuilMode ?? "AU_DELA" : null,
    seuilCumul: m === "POURCENTAGE_APRES_SEUIL" || m === "PALIERS" ? c.seuilCumul ?? "PAR_PERIODE" : null,
    forfaitCents: m === "FORFAIT" ? c.forfaitCents ?? null : null,
    minimumGarantiCents: m === "AUCUNE" ? null : c.minimumGarantiCents || null,
    paliersMode: m === "PALIERS" ? c.paliersMode ?? "MARGINAL" : null,
    paliers: m === "PALIERS" ? c.paliers : [],
    motifAvenant: c.motifAvenant ?? null,
  };
}

// GET /api/commissions/lieux/:id — contrats (versions), commission en cours, reversements
commissionsRouter.get(
  "/lieux/:id",
  exiger("ADMIN", "PARTENAIRE"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const [contrats, enCours, reversements] = await Promise.all([
      prisma.contratCommission.findMany({
        where: { lieuId },
        include: { paliers: { orderBy: { depuisCents: "asc" } }, creePar: { select: { nom: true, prenom: true } }, _count: { select: { reversements: true } } },
        orderBy: { version: "desc" },
      }),
      commissionEnCours(lieuId),
      prisma.reversement.findMany({ where: { lieuId }, orderBy: { periodeDebut: "desc" }, take: 24 }),
    ]);
    res.json({
      contrats: contrats.map((c) => ({ ...c, description: decrireContrat(regleDe(c)) })),
      enCours,
      reversements: reversements.map((r) => ({ ...r, periode: (r.detailCalcul as { periode?: string } | null)?.periode })),
    });
  })
);

// POST /api/commissions/lieux/:id/contrats — premier contrat ou avenant (nouvelle version)
commissionsRouter.post(
  "/lieux/:id/contrats",
  exiger("ADMIN"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    const { paliers, ...c } = normaliser(contratSchema.parse(req.body));

    const derniere = await prisma.contratCommission.findFirst({ where: { lieuId }, orderBy: { version: "desc" } });
    if (derniere && c.dateEffet <= derniere.dateEffet) {
      throw new HttpError(400, "DATE_EFFET", `L'avenant doit prendre effet après le ${ymd(derniere.dateEffet)} (version ${derniere.version})`);
    }
    // Un avenant ne recalcule jamais une période déjà validée
    const derniereFigee = await prisma.reversement.findFirst({
      where: { lieuId, statut: { in: [...STATUTS_FIGES] } },
      orderBy: { periodeFin: "desc" },
    });
    if (derniereFigee && c.dateEffet <= derniereFigee.periodeFin) {
      throw new HttpError(400, "PERIODE_VALIDEE", `Les reversements sont validés jusqu'au ${ymd(derniereFigee.periodeFin)} : l'avenant doit prendre effet après`);
    }

    const contrat = await prisma.$transaction(async (db) => {
      if (derniere && (!derniere.dateFin || derniere.dateFin > c.dateEffet)) {
        await db.contratCommission.update({ where: { id: derniere.id }, data: { dateFin: c.dateEffet } });
      }
      return db.contratCommission.create({
        data: {
          ...c,
          lieuId,
          version: (derniere?.version ?? 0) + 1,
          creeParId: req.utilisateur!.id,
          paliers: { create: paliers },
        },
        include: { paliers: true },
      });
    });
    await calculerReversements({ lieuId });
    res.status(201).json({ ...contrat, description: decrireContrat(regleDe(contrat)) });
  })
);

// DELETE /api/commissions/contrats/:id — annule la dernière version (saisie par erreur)
commissionsRouter.delete(
  "/contrats/:id",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const c = await prisma.contratCommission.findUniqueOrThrow({ where: { id: Number(req.params.id) } });
    const plusRecente = await prisma.contratCommission.findFirst({ where: { lieuId: c.lieuId, version: { gt: c.version } } });
    if (plusRecente) throw new HttpError(400, "PAS_DERNIERE_VERSION", "Seule la dernière version d'un contrat peut être supprimée");
    if (await prisma.reversement.count({ where: { contratId: c.id, statut: { in: [...STATUTS_FIGES] } } })) {
      throw new HttpError(400, "PERIODE_VALIDEE", "Des reversements validés reposent sur ce contrat");
    }
    await prisma.$transaction([
      prisma.reversement.deleteMany({ where: { contratId: c.id } }),
      prisma.contratCommission.delete({ where: { id: c.id } }),
      prisma.contratCommission.updateMany({ where: { lieuId: c.lieuId, dateFin: c.dateEffet }, data: { dateFin: null } }),
    ]);
    await calculerReversements({ lieuId: c.lieuId });
    res.status(204).end();
  })
);

// POST /api/commissions/simuler — commission pour quelques CA d'exemple (aperçu dans le formulaire)
commissionsRouter.post(
  "/simuler",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const parse = contratSchema.safeParse(req.body);
    if (!parse.success) return res.json({ valide: false });
    const regle: RegleContrat = normaliser(parse.data);
    const exemples = z.array(entier).max(10).parse(req.body.exemplesCents ?? [30000, 80000, 150000]);
    res.json({
      valide: true,
      description: decrireContrat(regle),
      exemples: exemples.map((caCents) => {
        const r = calculerPeriode(regle, { caTtcCents: caCents, caHtCents: caCents, rembourseTtcCents: 0, rembourseHtCents: 0 });
        return { caCents, commissionCents: r.commissionCents, minimumApplique: r.minimumApplique };
      }),
    });
  })
);

// ─── Reversements ───────────────────────────────────────────

// GET /api/reversements?statut=&lieuId=&du=&au=
reversementsRouter.get(
  "/",
  exiger("ADMIN", "PARTENAIRE"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const p = perimetreLieux(req.utilisateur);
    const statuts = req.query.statut ? (String(req.query.statut).split(",") as ReversementStatut[]) : undefined;
    const reversements = await prisma.reversement.findMany({
      where: {
        ...(statuts ? { statut: { in: statuts } } : {}),
        ...(req.query.lieuId ? { lieuId: Number(req.query.lieuId) } : {}),
        ...(p?.lieuId !== undefined ? { lieuId: p.lieuId } : {}),
        ...(req.query.du ? { periodeDebut: { gte: new Date(`${req.query.du}T00:00:00Z`) } } : {}),
        ...(req.query.au ? { periodeFin: { lte: new Date(`${req.query.au}T00:00:00Z`) } } : {}),
      },
      include: { lieu: { select: { id: true, enseigne: true, ville: true } } },
      orderBy: [{ periodeDebut: "desc" }, { lieu: { enseigne: "asc" } }],
      take: 500,
    });
    res.json(reversements.map((r) => ({ ...r, periode: (r.detailCalcul as { periode?: string } | null)?.periode })));
  })
);

// POST /api/reversements/calculer { lieuId? } — calcule les périodes terminées
reversementsRouter.post(
  "/calculer",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const lieuId = req.body?.lieuId ? Number(req.body.lieuId) : undefined;
    res.json(await calculerReversements({ lieuId }));
  })
);

// GET /api/reversements/export.csv — export comptable
reversementsRouter.get(
  "/export.csv",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const statuts = (req.query.statut ? String(req.query.statut).split(",") : [...STATUTS_FIGES]) as ReversementStatut[];
    const lignes = await prisma.reversement.findMany({
      where: { statut: { in: statuts } },
      include: { lieu: { select: { enseigne: true, raisonSociale: true, siret: true, crmClientId: true } } },
      orderBy: [{ periodeDebut: "asc" }, { lieuId: "asc" }],
    });
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");
    const date = (d: Date | null) => (d ? ymd(d).split("-").reverse().join("/") : "");
    const csv = [
      ["Lieu", "Raison sociale", "SIRET", "ID client CRM", "Début", "Fin", "Base de calcul", "Commission calculée", "Ajustements", "Montant à reverser", "Statut", "N° facture", "Validé le", "Payé le"].join(";"),
      ...lignes.map((r) =>
        [r.lieu.enseigne, r.lieu.raisonSociale, r.lieu.siret, r.lieu.crmClientId, date(r.periodeDebut), date(r.periodeFin),
         eur(r.baseCalculCents), eur(r.commissionCalculeeCents), eur(r.ajustementsCents), eur(r.montantAReverserCents),
         r.statut, r.numeroFacture, date(r.valideLe), date(r.payeLe)].map(cell).join(";")
      ),
    ].join("\r\n");
    await prisma.reversement.updateMany({ where: { id: { in: lignes.map((l) => l.id) } }, data: { exporteComptaLe: new Date() } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="reversements_${ymd(new Date())}.csv"`);
    res.send("﻿" + csv);
  })
);

// GET /api/reversements/:id — détail (relevé)
reversementsRouter.get(
  "/:id",
  exiger("ADMIN", "PARTENAIRE"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const r = await chargerReleve(Number(req.params.id));
    await verifierAccesLieu(req.utilisateur, r.lieuId);
    const { contacts, ...lieu } = r.lieu;
    res.json({
      ...r,
      lieu,
      // Destinataires proposés pour l'envoi par e-mail (admin seulement)
      destinatairesParDefaut: req.utilisateur?.role === "ADMIN" ? destinatairesParDefaut(r) : undefined,
      contactsEmail: req.utilisateur?.role === "ADMIN" ? contacts.filter((c) => c.email) : undefined,
    });
  })
);

// GET /api/reversements/:id/releve.pdf — relevé PDF (CDC §6)
reversementsRouter.get(
  "/:id/releve.pdf",
  exiger("ADMIN", "PARTENAIRE"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const r = await chargerReleve(Number(req.params.id));
    await verifierAccesLieu(req.utilisateur, r.lieuId);
    const pdf = await genererPdfReleve(r);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${nomFichierReleve(r)}"`);
    res.send(pdf);
  })
);

const ENVOYABLES = ["VALIDE", "FACTURE_PAR_LIEU", "AUTOFACTURE", "PAYE"] as const;

/** Envoie le relevé PDF par e-mail ; renvoie le motif d'échec ou null. */
async function envoyerReleve(r: Releve, destinataires: string[], message: string | null, userId: number) {
  const d = detailDe(r);
  const pdf = await genererPdfReleve(r);
  const echapper = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = [
    "<p>Bonjour,</p>",
    message ? `<p>${echapper(message).replace(/\n/g, "<br>")}</p>` : "",
    `<p>Veuillez trouver ci-joint le relevé de commission de <strong>${echapper(r.lieu.enseigne)}</strong> pour la période <strong>${echapper(d.periode ?? "")}</strong>.</p>`,
    `<p>Montant à reverser : <strong>${(r.montantAReverserCents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}</strong>.</p>`,
    "<p>Cordialement,<br>L'équipe Selfizee</p>",
  ].join("");
  const erreur = await envoyerEmail(destinataires, `Relevé de commission — ${r.lieu.enseigne} — ${d.periode ?? ""}`, html, [
    { nom: nomFichierReleve(r), type: "application/pdf", contenu: pdf },
  ]);
  if (!erreur) {
    await prisma.$transaction([
      prisma.reversement.update({ where: { id: r.id }, data: { envoyeLe: new Date() } }),
      prisma.auditLog.create({
        data: { userId: userId || null, entite: "reversement", entiteId: String(r.id), action: "ENVOI_RELEVE", apres: { destinataires } },
      }),
    ]);
  }
  return erreur;
}

// POST /api/reversements/envoyer-valides — envoie les relevés validés jamais envoyés, aux contacts par défaut
reversementsRouter.post(
  "/envoyer-valides",
  exiger("ADMIN"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    if (!emailConfigure()) throw new HttpError(503, "ENVOI_NON_CONFIGURE", "L'envoi d'e-mails n'est pas configuré (identifiants Mailjet)");
    const aEnvoyer = await prisma.reversement.findMany({
      where: { statut: { in: [...ENVOYABLES] }, envoyeLe: null },
      select: { id: true },
      orderBy: { periodeDebut: "asc" },
    });
    const resultat = { envoyes: 0, sansDestinataire: [] as string[], echecs: [] as { lieu: string; erreur: string }[] };
    for (const { id } of aEnvoyer) {
      const r = await chargerReleve(id);
      const destinataires = destinatairesParDefaut(r);
      const libelle = `${r.lieu.enseigne} (${detailDe(r).periode ?? ymd(r.periodeDebut)})`;
      if (!destinataires.length) {
        resultat.sansDestinataire.push(libelle);
        continue;
      }
      const erreur = await envoyerReleve(r, destinataires, null, req.utilisateur!.id);
      if (erreur) resultat.echecs.push({ lieu: libelle, erreur });
      else resultat.envoyes++;
    }
    res.json(resultat);
  })
);

// POST /api/reversements/:id/envoyer { destinataires, message? } — envoi du relevé PDF par e-mail
reversementsRouter.post(
  "/:id/envoyer",
  exiger("ADMIN"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { destinataires, message } = z
      .object({
        destinataires: z.array(z.email().transform((e) => e.toLowerCase())).min(1, "Au moins un destinataire"),
        message: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    const r = await chargerReleve(Number(req.params.id));
    if (!(ENVOYABLES as readonly string[]).includes(r.statut)) {
      throw new HttpError(400, "STATUT", "Le relevé doit être validé avant d'être envoyé au lieu");
    }
    if (!emailConfigure()) throw new HttpError(503, "ENVOI_NON_CONFIGURE", "L'envoi d'e-mails n'est pas configuré (identifiants Mailjet)");
    const erreur = await envoyerReleve(r, destinataires, message ?? null, req.utilisateur!.id);
    if (erreur) throw new HttpError(502, "ENVOI_ECHEC", erreur);
    res.json({ envoye: true, destinataires });
  })
);

// POST /api/reversements/:id/ajustements — correction manuelle tracée
reversementsRouter.post(
  "/:id/ajustements",
  exiger("ADMIN"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { montantCents, motif } = z
      .object({ montantCents: z.number().int().refine((v) => v !== 0, "Montant non nul"), motif: z.string().trim().min(3, "Motif obligatoire") })
      .parse(req.body);
    const id = Number(req.params.id);
    const r = await prisma.reversement.findUniqueOrThrow({ where: { id } });
    if (r.statut !== "CALCULE") throw new HttpError(400, "STATUT", "Les corrections se font avant validation");
    const maj = await prisma.$transaction(async (db) => {
      await db.reversementAjustement.create({ data: { reversementId: id, montantCents, motif, userId: req.utilisateur!.id } });
      return db.reversement.update({
        where: { id },
        data: { ajustementsCents: { increment: montantCents }, montantAReverserCents: { increment: montantCents } },
      });
    });
    res.status(201).json(maj);
  })
);

// Transitions de statut autorisées (CDC §6 : à calculer, validé, facturé / autofacturé, payé)
const TRANSITIONS: Partial<Record<ReversementStatut, ReversementStatut[]>> = {
  CALCULE: ["VALIDE"],
  VALIDE: ["CALCULE", "FACTURE_PAR_LIEU", "AUTOFACTURE"],
  FACTURE_PAR_LIEU: ["PAYE", "VALIDE"],
  AUTOFACTURE: ["PAYE", "VALIDE"],
  PAYE: ["FACTURE_PAR_LIEU", "AUTOFACTURE"],
};

// PATCH /api/reversements/:id/statut { statut, numeroFacture? }
reversementsRouter.patch(
  "/:id/statut",
  exiger("ADMIN"),
  asynchrone(async (req, res) => {
    const { statut, numeroFacture } = z
      .object({ statut: z.enum(ReversementStatut), numeroFacture: z.string().trim().nullable().optional() })
      .parse(req.body);
    const r = await prisma.reversement.findUniqueOrThrow({ where: { id: Number(req.params.id) } });
    if (!TRANSITIONS[r.statut]?.includes(statut)) {
      throw new HttpError(400, "TRANSITION", `Passage de ${r.statut} à ${statut} impossible`);
    }
    const maintenant = new Date();
    const data: Prisma.ReversementUpdateInput = { statut };
    if (statut === "VALIDE" && r.statut === "CALCULE") data.valideLe = maintenant;
    if (statut === "CALCULE") data.valideLe = null;
    if (statut === "FACTURE_PAR_LIEU" || statut === "AUTOFACTURE") {
      data.factureLe = maintenant;
      if (numeroFacture !== undefined) data.numeroFacture = numeroFacture;
    }
    if (statut === "PAYE") data.payeLe = maintenant;
    if (r.statut === "PAYE") data.payeLe = null;
    res.json(await prisma.reversement.update({ where: { id: r.id }, data }));
  })
);
