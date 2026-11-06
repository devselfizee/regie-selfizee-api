import { Router } from "express";
import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { FUSEAU_METIER } from "../lib/temps.js";
import { LOTS } from "../config-evenement/reglages.js";

// Page souvenir d'un lieu, dans la fiche lieu (CDC page souvenir § 9.1) : l'entonnoir de la soirée et les contacts
// opt-in lieu. Seulement les contacts qui ont coché « Les bons plans de <lieu> » : ni les autres inscrits, ni
// l'opt-in Selfizee (liste de Selfizee, gardée à part). Admin, commercial sur ses lieux, partenaire sur son lieu.

/** Routes sous /api/lieux/:id/souvenir */
export const souvenirLieuRouter = Router();
const voit = exiger("ADMIN", "COMMERCIAL", "PARTENAIRE");

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const periodeSchema = z.object({ du: z.string().regex(JOUR).optional(), au: z.string().regex(JOUR).optional(), evenement: z.coerce.number().int().positive().optional() });

function minuitParis(ymd: string, plusJours = 0): Date {
  const [a, m, j] = ymd.split("-").map(Number);
  return new Date(new TZDate(a, m - 1, j + plusJours, 0, 0, 0, FUSEAU_METIER).getTime());
}

async function cible(req: UtilisateurRequest) {
  const lieuId = Number(req.params.id);
  if (!Number.isInteger(lieuId)) throw new HttpError(404, "INTROUVABLE");
  await verifierAccesLieu(req.utilisateur, lieuId);
  const p = periodeSchema.parse(req.query);
  const quand = p.du || p.au ? { ...(p.du ? { gte: minuitParis(p.du) } : {}), ...(p.au ? { lt: minuitParis(p.au, 1) } : {}) } : undefined;
  return { lieuId, quand, evenement: p.evenement };
}

// GET /api/lieux/:id/souvenir/resume?du=&au=&evenement= — entonnoir : séances → scans → inscriptions → opt-ins, lots, codes
souvenirLieuRouter.get(
  "/:id/souvenir/resume",
  voit,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, quand, evenement } = await cible(req);
    const parEvt = evenement ? { configEvenementId: evenement } : {};
    const codeEvt = evenement ? (await prisma.configEvenement.findFirst({ where: { id: evenement, lieuId }, select: { code: true } }))?.code ?? "—" : undefined;
    const ins: Prisma.SouvenirInscriptionWhereInput = { lieuId, ...parEvt, ...(quand ? { createdAt: quand } : {}) };
    const [seances, scans, inscriptions, optinsLieu, optinsSelfizee, livraisons, lots, consommes, evenements] = await Promise.all([
      prisma.media.groupBy({ by: ["photoUuid"], where: { lieuId, test: false, photoUuid: { not: null }, ...parEvt, ...(quand ? { createdAt: quand } : {}) } }),
      prisma.souvenirJournal.groupBy({ by: ["photoUuid"], where: { lieuId, evenement: "page_view", photoUuid: { not: null }, ...(codeEvt ? { codeEvent: codeEvt } : {}), ...(quand ? { createdAt: quand } : {}) } }),
      prisma.souvenirInscription.count({ where: ins }),
      prisma.souvenirInscription.count({ where: { ...ins, optinLieu: true } }),
      prisma.souvenirInscription.count({ where: { ...ins, optinSelfizee: true } }),
      prisma.souvenirLivraison.groupBy({ by: ["etat"], where: { renvoi: false, inscription: ins }, _count: { _all: true } }),
      prisma.souvenirCarte.groupBy({ by: ["lot"], where: { inscription: ins }, _count: { _all: true } }),
      prisma.souvenirCarte.count({ where: { inscription: ins, codeRemise: { utilise: { gt: 0 } } } }),
      prisma.configEvenement.findMany({ where: { lieuId }, select: { id: true, code: true, nom: true, habituel: true }, orderBy: [{ habituel: "desc" }, { id: "asc" }] }),
    ]);
    const parLot = Object.fromEntries(LOTS.map((l) => [l, lots.find((x) => x.lot === l)?._count._all ?? 0])) as Record<(typeof LOTS)[number], number>;
    const parEtat = (e: string) => livraisons.find((x) => x.etat === e)?._count._all ?? 0;
    res.json({
      seances: seances.length,
      scans: scans.length,
      inscriptions,
      optinsLieu,
      optinsSelfizee,
      livraisons: { aEnvoyer: parEtat("A_ENVOYER"), envoyees: parEtat("ENVOYE"), enAttenteMedia: parEtat("EN_ATTENTE_MEDIA"), echecs: parEtat("ECHEC") },
      cartes: LOTS.reduce((s, l) => s + parLot[l], 0),
      lots: parLot,
      codesConsommes: consommes,
      evenements,
    });
  })
);

/** Contacts opt-in lieu encore valables (jamais une inscription anonymisée), les plus récents d'abord. */
async function contacts(lieuId: number, quand: Prisma.DateTimeFilter | undefined, evenement: number | undefined, take?: number) {
  const where: Prisma.SouvenirInscriptionWhereInput = { lieuId, optinLieu: true, email: { not: null }, ...(evenement ? { configEvenementId: evenement } : {}), ...(quand ? { createdAt: quand } : {}) };
  const [total, lignes] = await Promise.all([
    prisma.souvenirInscription.count({ where }),
    prisma.souvenirInscription.findMany({
      where,
      select: { id: true, email: true, prenom: true, createdAt: true, codeEvent: true, photoUuid: true, textes: true, evenement: { select: { nom: true, habituel: true } } },
      orderBy: { createdAt: "desc" },
      ...(take ? { take } : {}),
    }),
  ]);
  return {
    total,
    contacts: lignes.map((l) => ({
      id: l.id,
      email: l.email!,
      prenom: l.prenom,
      date: l.createdAt,
      codeEvent: l.codeEvent,
      evenement: l.evenement ? (l.evenement.habituel ? "Par défaut" : l.evenement.nom) : null,
      photoUuid: l.photoUuid,
      // Texte de la case accepté (2e case du formulaire), tel qu'il était affiché
      texteAccepte: Array.isArray(l.textes) ? String((l.textes as unknown[])[1] ?? "") : "",
    })),
  };
}

// GET /api/lieux/:id/souvenir/contacts?du=&au=&evenement= — les 200 contacts opt-in lieu les plus récents (et le total)
souvenirLieuRouter.get(
  "/:id/souvenir/contacts",
  voit,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, quand, evenement } = await cible(req);
    res.json(await contacts(lieuId, quand, evenement, 200));
  })
);

const cellule = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const paris = new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU_METIER, dateStyle: "short", timeStyle: "short" });

// GET /api/lieux/:id/souvenir/contacts.csv?du=&au=&evenement= — export CSV des contacts opt-in lieu (CDC § 9.1)
souvenirLieuRouter.get(
  "/:id/souvenir/contacts.csv",
  voit,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const { lieuId, quand, evenement } = await cible(req);
    const { contacts: lignes } = await contacts(lieuId, quand, evenement);
    // Export de données personnelles : tracé (qui, quand, combien)
    await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "lieu", entiteId: String(lieuId), action: "EXPORT_CONTACTS_SOUVENIR", apres: { nb: lignes.length, du: String(req.query.du ?? ""), au: String(req.query.au ?? "") } } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="contacts-optin-lieu-${lieuId}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.write("\uFEFF");
    res.write(["E-mail", "Prénom", "Date", "Événement", "Code événement", "photo_uuid", "Opt-in accepté"].join(";") + "\r\n");
    res.end(lignes.map((l) => [l.email, l.prenom, paris.format(l.date), l.evenement, l.codeEvent, l.photoUuid, l.texteAccepte].map(cellule).join(";")).join("\r\n") + (lignes.length ? "\r\n" : ""));
  })
);
