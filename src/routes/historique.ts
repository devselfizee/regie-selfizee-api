import { Router } from "express";
import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { FUSEAU_METIER } from "../lib/temps.js";
import { perimetreLieux, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { perimetre as perimetreAlertes, SANS_SUPPRIMES } from "./alertes.js";
import { userCan } from "../middleware/permissions.js";

// Historique de la Régie (page « Historique ») : une seule chronologie, de la plus récente à la plus ancienne, de ce
// qui est déjà enregistré ailleurs : téléchargements d'événements par les bornes, publications d'événements, actions
// des utilisateurs (journal d'audit), alertes, envois refusés des bornes. Rien n'est recopié (ni trigger ni table en
// plus) : chaque source est lue sur son index de date, les pages fusionnées ici. Lecture par curseur, sans total : le
// coût d'une page ne dépend pas de la taille des tables. Réservé à qui voit tous les lieux ; chaque type a son droit.
export const historiqueRouter = Router();

export const TYPES = ["telechargement", "publication", "utilisateur", "alerte", "borne"] as const;
export type TypeHistorique = (typeof TYPES)[number];
const DROITS: Record<TypeHistorique, string[]> = {
  telechargement: ["bornes.view"],
  borne: ["bornes.view"],
  publication: ["evenements.view"],
  utilisateur: ["utilisateurs.manage"],
  alerte: ["alertes.techniques_view", "alertes.ventes_view"],
};

export interface LigneHistorique {
  /** Unique dans tout l'historique : « tel-12 », « audit-34 »… */
  cle: string;
  type: TypeHistorique;
  date: Date;
  titre: string;
  detail: string | null;
  /** info, ok, attention, critique : la couleur de la ligne */
  ton: "info" | "ok" | "attention" | "critique";
  lieu: { id: number; enseigne: string } | null;
  borne: { id: number | null; identifiant: string } | null;
  utilisateur: string | null;
  /** Événement de borne concerné (lien vers sa fiche) */
  evenement: { id: number; lieuId: number; parDefaut: boolean; nom: string | null; code: string } | null;
  /** Étape d'un téléchargement : la page regroupe les étapes d'un même téléchargement (borne, code, version) en une ligne */
  telechargement?: { etat: string; code: string; version: number; declencheur: "AUTO" | "MANUEL" | null; message: string | null };
}

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const minuitParis = (ymd: string, plusJours = 0) => {
  const [a, m, j] = ymd.split("-").map(Number);
  return new Date(new TZDate(a, m - 1, j + plusJours, 0, 0, 0, FUSEAU_METIER).getTime());
};

const filtresSchema = z.object({
  types: z.string().max(100).optional(),
  lieuId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  borneId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  du: z.string().regex(JOUR).optional(),
  au: z.string().regex(JOUR).optional(),
  // Curseur : « <date ISO>|<clés déjà vues à cet instant, séparées par des virgules> »
  // 6000 caractères : de quoi porter ~400 lignes au même instant (un import en lot) sans bloquer « Charger la suite »
  avant: z.string().max(6000).optional(),
  limite: z.coerce.number().int().min(1).max(100).default(40),
});

interface Fenetre {
  /** Borne haute incluse (les lignes de cet instant déjà vues sont retirées ensuite) */
  avant: Date | null;
  du: Date | null;
  lieuId?: number;
  borneId?: number;
  limite: number;
}
const periode = (f: Fenetre) => ({ ...(f.avant ? { lte: f.avant } : {}), ...(f.du ? { gte: f.du } : {}) });
const aPeriode = (f: Fenetre) => Boolean(f.avant || f.du);

// ─── Sources ───

const ETAPES: Record<string, { titre: string; ton: LigneHistorique["ton"] }> = {
  DEMANDE: { titre: "Zip demandé", ton: "info" },
  ENVOYE: { titre: "Zip envoyé à la borne", ton: "info" },
  TELECHARGE: { titre: "Événement téléchargé", ton: "ok" },
  INSTALLE: { titre: "Événement installé", ton: "ok" },
  ECHEC: { titre: "Échec du téléchargement", ton: "critique" },
};

async function telechargements(f: Fenetre): Promise<LigneHistorique[]> {
  const lignes = await prisma.installationEvenement.findMany({
    where: { ...(aPeriode(f) ? { createdAt: periode(f) } : {}), ...(f.lieuId ? { lieuId: f.lieuId } : {}), ...(f.borneId ? { borneId: f.borneId } : {}) },
    orderBy: { createdAt: "desc" },
    take: f.limite,
    select: {
      id: true, createdAt: true, code: true, version: true, etat: true, declencheur: true, message: true,
      borne: { select: { id: true, identifiant: true } },
      evenement: { select: { id: true, nom: true, habituel: true, code: true, lieu: { select: { id: true, enseigne: true } } } },
    },
  });
  return lignes.map((l) => ({
    cle: `tel-${l.id}`,
    type: "telechargement",
    date: l.createdAt,
    titre: `${ETAPES[l.etat].titre} · ${l.evenement ? (l.evenement.habituel ? "Par défaut" : l.evenement.nom ?? "Événement") : "événement inconnu"} (${l.code}, v${l.version})`,
    detail: [l.declencheur === "AUTO" ? "Mise à jour automatique" : l.declencheur === "MANUEL" ? "Code tapé sur la borne" : null, l.message].filter(Boolean).join(" · ") || null,
    ton: ETAPES[l.etat].ton,
    lieu: l.evenement?.lieu ?? null,
    borne: l.borne,
    utilisateur: null,
    evenement: l.evenement ? { id: l.evenement.id, lieuId: l.evenement.lieu.id, parDefaut: l.evenement.habituel, nom: l.evenement.nom, code: l.evenement.code } : null,
    telechargement: { etat: l.etat, code: l.code, version: l.version, declencheur: l.declencheur, message: l.message },
  }));
}

/**
 * Le lieu de chaque borne citée sans lieu (un envoi refusé ne porte que l'identifiant de la borne : « C113 » seul ne dit
 * rien) : le lieu où elle est installée aujourd'hui. Une borne connue par son identifiant retrouve aussi son lien.
 */
async function situerLesBornes(lignes: LigneHistorique[]): Promise<void> {
  const aSituer = lignes.filter((l) => l.borne && !l.lieu);
  if (!aSituer.length) return;
  const maintenant = new Date();
  const bornes = await prisma.borne.findMany({
    where: { identifiant: { in: [...new Set(aSituer.map((l) => l.borne!.identifiant))] } },
    select: {
      id: true,
      identifiant: true,
      affectations: {
        where: { debut: { lte: maintenant }, OR: [{ fin: null }, { fin: { gt: maintenant } }] },
        orderBy: { debut: "desc" },
        take: 1,
        select: { lieu: { select: { id: true, enseigne: true } } },
      },
    },
  });
  const parIdentifiant = new Map(bornes.map((b) => [b.identifiant, b]));
  for (const l of aSituer) {
    const b = parIdentifiant.get(l.borne!.identifiant);
    if (!b) continue;
    l.borne = { id: b.id, identifiant: b.identifiant };
    l.lieu = b.affectations[0]?.lieu ?? null;
  }
}

// Journal d'audit : ce que chaque action veut dire, en clair
const ENTITES: Record<string, string> = {
  lieu: "le lieu", config_evenement: "l'événement", cadre_evenement: "un cadre", transaction: "une vente", reversement: "un reversement",
  lot_codes_remise: "des codes de remise", tarifs_base: "les tarifs de base", modele_mail: "un modèle de mail", carte_test: "une carte de test",
  illustration_serie: "une série d'illustrations", illustration_lieu: "une illustration du lieu", concurrent: "les concurrents",
};
const ACTIONS: Record<string, string> = {
  CREATION: "a créé", MODIFICATION: "a modifié", SUPPRESSION: "a supprimé", PUBLICATION: "a publié", TARIFS: "a modifié les tarifs de",
  REMBOURSEMENT: "a remboursé", ENVOI_RELEVE: "a envoyé le relevé pour", RETOUR_DEFAUT: "a remis par défaut", SUPPRESSION_CODES: "a supprimé",
  EXPORT_CONTACTS_SOUVENIR: "a exporté les contacts de", IMPORT_EMPLACEMENTS: "a importé des emplacements pour", GOOGLE_EMPLACEMENTS: "a cherché sur Google",
  CATEGORISER_EMPLACEMENTS: "a catégorisé les emplacements de",
};

async function audit(f: Fenetre, publications: boolean): Promise<LigneHistorique[]> {
  if (f.borneId) return []; // le journal d'audit ne porte pas sur une borne
  // Par lieu : ses propres lignes et celles de ses événements
  let cible: Prisma.AuditLogWhereInput = {};
  if (f.lieuId) {
    const evenements = await prisma.configEvenement.findMany({ where: { lieuId: f.lieuId }, select: { id: true } });
    cible = { OR: [{ entite: "lieu", entiteId: String(f.lieuId) }, { entite: "config_evenement", entiteId: { in: evenements.map((e) => String(e.id)) } }] };
  }
  const estPublication: Prisma.AuditLogWhereInput = { entite: "config_evenement", action: "PUBLICATION" };
  const lignes = await prisma.auditLog.findMany({
    where: { AND: [cible, publications ? estPublication : { NOT: estPublication }, aPeriode(f) ? { createdAt: periode(f) } : {}] },
    orderBy: { createdAt: "desc" },
    take: f.limite,
    select: { id: true, createdAt: true, entite: true, entiteId: true, action: true, apres: true, user: { select: { prenom: true, nom: true } } },
  });
  // Noms des événements et des lieux cités, en deux requêtes
  const ids = (entite: string) => [...new Set(lignes.filter((l) => l.entite === entite && /^\d+$/.test(l.entiteId)).map((l) => Number(l.entiteId)))];
  const [evenements, lieux] = await Promise.all([
    prisma.configEvenement.findMany({ where: { id: { in: ids("config_evenement") } }, select: { id: true, nom: true, habituel: true, code: true, lieu: { select: { id: true, enseigne: true } } } }),
    prisma.lieu.findMany({ where: { id: { in: ids("lieu") } }, select: { id: true, enseigne: true } }),
  ]);
  const evenement = new Map(evenements.map((e) => [String(e.id), e]));
  const lieu = new Map(lieux.map((l) => [String(l.id), l]));
  return lignes.map((l) => {
    const e = l.entite === "config_evenement" ? evenement.get(l.entiteId) : undefined;
    const lieuLigne = e?.lieu ?? (l.entite === "lieu" ? lieu.get(l.entiteId) : undefined) ?? null;
    const qui = l.user ? `${l.user.prenom} ${l.user.nom}`.trim() : null;
    const quoi = e ? `l'événement « ${e.habituel ? "Par défaut" : e.nom ?? "Événement"} » (${e.code})` : lieuLigne && l.entite === "lieu" ? `le lieu ${lieuLigne.enseigne}` : (ENTITES[l.entite] ?? l.entite.replace(/_/g, " "));
    const version = publications && l.apres && typeof l.apres === "object" && "version" in l.apres ? ` · version ${String((l.apres as { version: unknown }).version)}` : "";
    return {
      cle: `audit-${l.id}`,
      type: publications ? "publication" : "utilisateur",
      date: l.createdAt,
      titre: `${qui ?? "Quelqu'un"} ${ACTIONS[l.action] ?? l.action.toLowerCase().replace(/_/g, " ")} ${quoi}${version}`,
      detail: null,
      ton: publications ? "ok" : l.action.startsWith("SUPPRESSION") ? "attention" : "info",
      lieu: lieuLigne,
      borne: null,
      utilisateur: qui,
      evenement: e ? { id: e.id, lieuId: e.lieu.id, parDefaut: e.habituel, nom: e.nom, code: e.code } : null,
    };
  });
}

/** `visibles` : le filtre de la page Alertes (techniques et/ou de vente selon les droits, lieux et bornes non supprimés). */
async function alertes(f: Fenetre, visibles: Prisma.AlerteWhereInput): Promise<LigneHistorique[]> {
  const lignes = await prisma.alerte.findMany({
    where: { AND: [visibles, { ...(aPeriode(f) ? { detecteeLe: periode(f) } : {}), ...(f.lieuId ? { lieuId: f.lieuId } : {}), ...(f.borneId ? { borneId: f.borneId } : {}) }] },
    orderBy: { detecteeLe: "desc" },
    take: f.limite,
    select: {
      id: true, detecteeLe: true, niveau: true, statut: true, message: true,
      lieu: { select: { id: true, enseigne: true } },
      borne: { select: { id: true, identifiant: true } },
    },
  });
  return lignes.map((a) => ({
    cle: `alerte-${a.id}`,
    type: "alerte",
    date: a.detecteeLe,
    titre: a.message,
    detail: a.statut === "NOUVELLE" ? "Pas encore traitée" : a.statut.toLowerCase().replace(/_/g, " "),
    ton: a.niveau === "CRITIQUE" ? "critique" : a.niveau === "WARNING" ? "attention" : "info",
    lieu: a.lieu,
    borne: a.borne,
    utilisateur: null,
    evenement: null,
  }));
}

const LIBELLES_IMPORT: Record<string, string> = {
  TRANSACTIONS: "ventes", HEARTBEAT: "heartbeat", RELEVE_MONETIQUE: "relevé monétique", PARCOURS: "parcours invité", CODES: "code de remise", MEDIAS: "médias", CONFIG: "zip de l'événement",
};

/** Envois des bornes refusés ou partiels seulement : les envois acceptés (un heartbeat par minute) noieraient tout. */
async function bornes(f: Fenetre): Promise<LigneHistorique[]> {
  if (f.lieuId) return []; // un envoi n'est pas rattaché à un lieu
  const lignes = await prisma.importLot.findMany({
    where: { statut: { in: ["REJETE", "PARTIEL"] }, ...(aPeriode(f) ? { recuLe: periode(f) } : {}), ...(f.borneId ? { borneId: f.borneId } : {}) },
    orderBy: { recuLe: "desc" },
    take: f.limite,
    select: {
      id: true, recuLe: true, type: true, statut: true, borneIdentifiant: true, nbRecues: true, nbRejetees: true,
      borne: { select: { id: true, identifiant: true } },
      erreurs: { take: 1, select: { code: true, message: true } },
    },
  });
  return lignes.map((l) => ({
    cle: `import-${l.id}`,
    type: "borne",
    date: l.recuLe,
    titre: `Envoi ${l.statut === "REJETE" ? "refusé" : "en partie rejeté"} : ${LIBELLES_IMPORT[l.type] ?? l.type.toLowerCase()}`,
    detail: l.erreurs[0] ? `${l.erreurs[0].code}${l.erreurs[0].message ? ` : ${l.erreurs[0].message}` : ""}`.slice(0, 300) : l.statut === "PARTIEL" ? `${l.nbRejetees} ligne(s) rejetée(s) sur ${l.nbRecues}` : null,
    ton: l.statut === "REJETE" ? "critique" : "attention",
    lieu: null,
    borne: l.borne ?? (l.borneIdentifiant ? { id: null, identifiant: l.borneIdentifiant } : null),
    utilisateur: null,
    evenement: null,
  }));
}

/**
 * Fusionne les pages des sources : les `limite` plus récentes, et le curseur de la suite (null à la fin). Le curseur
 * garde l'instant de la dernière ligne et les clés déjà rendues à cet instant précis : la page suivante reprend à cet
 * instant inclus, sans doublon ni ligne sautée quand plusieurs lignes ont la même date.
 */
export function fusionner(pages: LigneHistorique[][], limite: number, dejaVues: Set<string>, instantPrecedent: number | null) {
  const toutes = pages.flat().filter((l) => !dejaVues.has(l.cle)).sort((a, b) => b.date.getTime() - a.date.getTime() || (a.cle < b.cle ? -1 : 1));
  const lignes = toutes.slice(0, limite);
  const derniere = lignes.at(-1);
  // Chaque source a été lue au-delà de la limite : s'il n'en reste pas ici, il n'en reste nulle part
  if (!derniere || toutes.length <= limite) return { lignes, suivant: null };
  const instant = derniere.date.getTime();
  const memes = [...lignes.filter((l) => l.date.getTime() === instant).map((l) => l.cle), ...(instant === instantPrecedent ? dejaVues : [])];
  return { lignes, suivant: `${derniere.date.toISOString()}|${memes.join(",")}` };
}

// GET /api/historique?types=telechargement,alerte&lieuId=&borneId=&du=&au=&avant=&limite=
historiqueRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    if (perimetreLieux(req.utilisateur) !== null) throw new HttpError(403, "INTERDIT", "L'historique est réservé à ceux qui voient tous les lieux.");
    const f = filtresSchema.parse(req.query);
    // Types permis à l'utilisateur, puis ceux qu'il demande
    const permis: TypeHistorique[] = [];
    for (const t of TYPES) {
      for (const droit of DROITS[t]) {
        if (await userCan(req, droit)) {
          permis.push(t);
          break;
        }
      }
    }
    if (!permis.length) throw new HttpError(403, "INTERDIT");
    const demandes = f.types ? f.types.split(",").map((t) => t.trim()) : [];
    const types = demandes.length ? permis.filter((t) => demandes.includes(t)) : permis;

    const [isoAvant, vues] = (f.avant ?? "|").split("|");
    const avant = isoAvant && !Number.isNaN(Date.parse(isoAvant)) ? new Date(isoAvant) : f.au ? new Date(minuitParis(f.au, 1).getTime() - 1) : null;
    const fenetre: Fenetre = { avant, du: f.du ? minuitParis(f.du) : null, lieuId: f.lieuId, borneId: f.borneId, limite: f.limite + 1 + (vues ? vues.split(",").length : 0) };
    // Mêmes alertes que la page Alertes : techniques et/ou de vente selon les droits, sans les lieux et bornes supprimés
    const alertesVisibles: Prisma.AlerteWhereInput = types.includes("alerte") ? { AND: [await perimetreAlertes(req), SANS_SUPPRIMES] } : {};
    const pages = await Promise.all(
      types.map((t) => (t === "telechargement" ? telechargements(fenetre) : t === "publication" ? audit(fenetre, true) : t === "utilisateur" ? audit(fenetre, false) : t === "alerte" ? alertes(fenetre, alertesVisibles) : bornes(fenetre)))
    );
    const curseur = isoAvant && !Number.isNaN(Date.parse(isoAvant)) ? Date.parse(isoAvant) : null;
    const page = fusionner(pages, f.limite, new Set(vues ? vues.split(",").filter(Boolean) : []), curseur);
    await situerLesBornes(page.lignes);
    res.json({ ...page, typesPermis: permis });
  })
);
