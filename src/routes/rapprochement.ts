import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { envoyerClasseur, euros } from "../lib/excel.js";
import { interpreter, lireCsv, suggererColonnes } from "../rapprochement/csv.js";
import { alerterEcarts, importerReleve, rapport, rapprocher, supprimerReleve } from "../rapprochement/service.js";

// Rapprochement avec les relevés du prestataire monétique (CDC §4), réservé à l'admin.
export const rapprochementRouter = Router();

const MAX_ERREURS = 50;

// POST /api/rapprochement/apercu { contenu } — en-têtes, premières lignes et colonnes devinées
rapprochementRouter.post(
  "/apercu",
  asynchrone(async (req, res) => {
    const { contenu } = z.object({ contenu: z.string().min(1) }).parse(req.body);
    const csv = lireCsv(contenu);
    if (!csv.entetes.length) throw new HttpError(400, "FICHIER_VIDE", "Le fichier est vide");
    res.json({
      separateur: csv.separateur,
      entetes: csv.entetes,
      exemples: csv.lignes.slice(0, 8),
      nbLignes: csv.lignes.length,
      colonnes: suggererColonnes(csv.entetes),
    });
  })
);

const colonne = z.number().int().min(0);
const importSchema = z.object({
  fournisseur: z.string().trim().min(1).max(60),
  fichierNom: z.string().trim().min(1).max(200),
  contenu: z.string().min(1),
  colonnes: z.object({
    date: colonne,
    heure: colonne.nullable().optional(),
    montant: colonne,
    reference: colonne.nullable().optional(),
    terminal: colonne,
  }),
  montantEnCentimes: z.boolean().optional(),
});

// POST /api/rapprochement/releves — importe le relevé et le rapproche aussitôt
rapprochementRouter.post(
  "/releves",
  asynchrone(async (req, res) => {
    const b = importSchema.parse(req.body);
    const { lignes, erreurs } = interpreter(lireCsv(b.contenu), b.colonnes, b.montantEnCentimes);
    if (!lignes.length) {
      return res.status(400).json({ error: "RELEVE_VIDE", message: "Aucune ligne exploitable avec ces colonnes", erreurs: erreurs.slice(0, MAX_ERREURS) });
    }
    const { releve, doublons } = await importerReleve(b.fournisseur, b.fichierNom, lignes);
    const r = await rapport(releve.id);
    const alertes = await alerterEcarts(r);
    res.status(201).json({ ...r, import: { lignes: lignes.length - doublons, doublons, rejetees: erreurs.length, erreurs: erreurs.slice(0, MAX_ERREURS), alertes: alertes.length } });
  })
);

// GET /api/rapprochement/releves — relevés importés avec leur bilan
rapprochementRouter.get(
  "/releves",
  asynchrone(async (_req, res) => {
    const [releves, compte] = await Promise.all([
      prisma.releveMonetique.findMany({ orderBy: [{ periodeFin: "desc" }, { id: "desc" }] }),
      prisma.releveLigne.groupBy({ by: ["releveId", "statut"], _count: true, _sum: { montantCents: true } }),
    ]);
    res.json(
      releves.map((r) => {
        const de = (s: string) => compte.find((c) => c.releveId === r.id && c.statut === s);
        const lignes = compte.filter((c) => c.releveId === r.id);
        return {
          ...r,
          periodeDebut: r.periodeDebut.toISOString().slice(0, 10),
          periodeFin: r.periodeFin.toISOString().slice(0, 10),
          lignes: lignes.reduce((s, c) => s + c._count, 0),
          montantCents: lignes.reduce((s, c) => s + (c._sum.montantCents ?? 0), 0),
          rapprochees: de("RAPPROCHE")?._count ?? 0,
          ecarts: de("ECART")?._count ?? 0,
          nonRapprochees: de("NON_RAPPROCHE")?._count ?? 0,
        };
      })
    );
  })
);

// GET /api/rapprochement/releves/:id — synthèse, détail par terminal et anomalies
rapprochementRouter.get(
  "/releves/:id",
  asynchrone(async (req, res) => {
    res.json(await rapport(Number(req.params.id)));
  })
);

// POST /api/rapprochement/releves/:id/relancer — après réception de ventes en retard
rapprochementRouter.post(
  "/releves/:id/relancer",
  asynchrone(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.releveMonetique.findUnique({ where: { id } }))) throw new HttpError(404, "INTROUVABLE");
    const nouveaux = await rapprocher(id);
    res.json({ ...(await rapport(id)), nouveaux });
  })
);

// DELETE /api/rapprochement/releves/:id — mauvais fichier ou mauvaises colonnes
rapprochementRouter.delete(
  "/releves/:id",
  asynchrone(async (req, res) => {
    await supprimerReleve(Number(req.params.id));
    res.status(204).end();
  })
);

// GET /api/rapprochement/releves/:id/anomalies.xlsx — toutes les anomalies, à traiter avec le prestataire
rapprochementRouter.get(
  "/releves/:id/anomalies.xlsx",
  asynchrone(async (req, res) => {
    const r = await rapport(Number(req.params.id), { complet: true });
    const paris = (d: Date) => {
      const p = Object.fromEntries(
        new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
          .formatToParts(d)
          .map((x) => [x.type, x.value])
      );
      return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
    };
    type Ligne = { type: string; horodatage: Date; terminal: string; borne: string; lieu: string; releve: number | null; vente: number | null; reference: string | null; transaction: string | null };
    const lignes: Ligne[] = [
      ...r.nonRemontees.map((l) => ({ type: "Encaissé non remonté", horodatage: l.horodatage, terminal: l.terminal, borne: l.borne?.identifiant ?? "", lieu: l.borne?.lieu?.enseigne ?? "", releve: l.montantCents, vente: null, reference: l.reference, transaction: null })),
      ...r.nonEncaissees.map((v) => ({ type: "Remonté non encaissé", horodatage: v.horodatage, terminal: v.terminal, borne: v.borne?.identifiant ?? "", lieu: v.lieu?.enseigne ?? "", releve: null, vente: v.montantCents, reference: null, transaction: v.transactionId })),
      ...r.ecarts.map((e) => ({ type: "Écart de montant", horodatage: e.horodatage, terminal: e.terminal, borne: e.borne?.identifiant ?? "", lieu: e.borne?.lieu?.enseigne ?? "", releve: e.montantCents, vente: e.vente.montantCents, reference: e.reference, transaction: e.vente.transactionId })),
    ].sort((a, b) => a.horodatage.getTime() - b.horodatage.getTime());
    await envoyerClasseur(res, `anomalies_${r.releve.fournisseur}_${r.releve.periodeDebut}_${r.releve.periodeFin}.xlsx`.replace(/[^\w.-]/g, "_"), "Anomalies", [
      { entete: "Type", valeur: (l: Ligne) => l.type, largeur: 22 },
      { entete: "Date et heure", valeur: (l) => paris(l.horodatage), format: "dateHeure", largeur: 18 },
      { entete: "Terminal", valeur: (l) => l.terminal, largeur: 14 },
      { entete: "Borne", valeur: (l) => l.borne },
      { entete: "Lieu", valeur: (l) => l.lieu, largeur: 26 },
      { entete: "Montant relevé", valeur: (l) => euros(l.releve), format: "euros", largeur: 15 },
      { entete: "Montant borne", valeur: (l) => euros(l.vente), format: "euros", largeur: 15 },
      { entete: "Référence", valeur: (l) => l.reference, largeur: 16 },
      { entete: "ID transaction borne", valeur: (l) => l.transaction, largeur: 24 },
    ], lignes);
  })
);
