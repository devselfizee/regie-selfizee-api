import { Router } from "express";
import { BaseCalcul } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { requirePerm } from "../middleware/permissions.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { libelleTaux, tableauApport, type TableauApport, type VentesMois } from "../apporteurs/calcul.js";

// Apporteurs d'affaires (demande du 17/11/2026) : un ami, une antenne… qui a recommandé un lieu et touche un % des
// ventes. Il voit un point mensuel très synthétique (CA généré, sa commission), rien d'autre : ni photos, ni fiches.
export const apporteursRouter = Router();

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const aujourdhui = () => jourEtHeureLocaux(new Date()).jour;

const selectRegle = {
  id: true, userId: true, lieuId: true, tauxBp: true, base: true, netRemboursements: true, dateDebut: true, dateFin: true, notes: true, createdAt: true,
  lieu: { select: { id: true, enseigne: true, ville: true, statut: true } },
} as const;
const selectApporteur = { id: true, email: true, nom: true, prenom: true, isActive: true, keycloakSub: true } as const;

/** Ventes d'un lieu par mois (agg_jour), entre deux jours inclus ; clé `${lieuId}:${YYYY-MM}` */
async function ventesParMois(lieuId: number, du: Date, au: Date): Promise<Map<string, VentesMois>> {
  const lignes = await prisma.$queryRaw<{ mois: string; ca_ttc: number; ca_ht: number; remb_ttc: number; remb_ht: number; nb: number }[]>`
    SELECT to_char(jour, 'YYYY-MM') mois,
           coalesce(sum(ca_ttc_cents), 0)::float8 ca_ttc, coalesce(sum(ca_ht_cents), 0)::float8 ca_ht,
           coalesce(sum(rembourse_ttc_cents), 0)::float8 remb_ttc, coalesce(sum(rembourse_ht_cents), 0)::float8 remb_ht,
           coalesce(sum(nb_acceptees), 0)::float8 nb
    FROM agg_jour WHERE lieu_id = ${lieuId} AND jour BETWEEN ${ymd(du)}::date AND ${ymd(au)}::date
    GROUP BY 1`;
  return new Map(lignes.map((l) => [`${lieuId}:${l.mois}`, { caTtcCents: l.ca_ttc, caHtCents: l.ca_ht, rembourseTtcCents: l.remb_ttc, rembourseHtCents: l.remb_ht, nbVentes: l.nb }]));
}

/** Tableau mensuel d'un apporteur (ses lieux non supprimés) */
export async function tableauDe(userId: number): Promise<TableauApport> {
  const regles = await prisma.apporteurLieu.findMany({ where: { userId, lieu: { supprimeLe: null } }, select: selectRegle, orderBy: { lieu: { enseigne: "asc" } } });
  const jour = aujourdhui();
  // Les ventes d'un lieu sont comptées jour par jour entre la date de début et la date de fin de chaque règle
  const ventes = new Map<string, VentesMois>();
  for (const r of regles) {
    const au = r.dateFin && r.dateFin < jour ? r.dateFin : jour;
    if (au < r.dateDebut) continue;
    for (const [k, v] of await ventesParMois(r.lieuId, r.dateDebut, au)) ventes.set(k, v);
  }
  return tableauApport(
    regles.map((r) => ({ lieuId: r.lieuId, enseigne: r.lieu.enseigne, ville: r.lieu.ville, tauxBp: r.tauxBp, base: r.base, netRemboursements: r.netRemboursements, dateDebut: r.dateDebut, dateFin: r.dateFin })),
    ventes,
    jour
  );
}

const presenterRegle = (r: { tauxBp: number } & Record<string, unknown>) => ({ ...r, taux: libelleTaux(r.tauxBp) });

// ─── L'apporteur lui-même ───────────────────────────────────

// GET /api/apporteurs/moi — mon point mensuel : CA généré par mes lieux et ma commission, rien d'autre
apporteursRouter.get(
  "/moi",
  requirePerm("apporteurs.view_own"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const userId = req.utilisateur!.id;
    const regles = await prisma.apporteurLieu.findMany({ where: { userId, lieu: { supprimeLe: null } }, select: { lieu: { select: { id: true, enseigne: true, ville: true } }, tauxBp: true, dateDebut: true, dateFin: true }, orderBy: { lieu: { enseigne: "asc" } } });
    res.json({
      lieux: regles.map((r) => ({ ...r.lieu, taux: libelleTaux(r.tauxBp), dateDebut: ymd(r.dateDebut), dateFin: r.dateFin ? ymd(r.dateFin) : null })),
      ...(await tableauDe(userId)),
    });
  })
);

// ─── Gestion (apporteurs.manage) ────────────────────────────

const gerer = requirePerm("apporteurs.manage");

// GET /api/apporteurs — les apporteurs, leurs lieux et leurs taux, avec la commission du dernier mois terminé et de l'année
apporteursRouter.get(
  "/",
  gerer,
  asynchrone(async (_req, res) => {
    const regles = await prisma.apporteurLieu.findMany({ where: { lieu: { supprimeLe: null } }, select: { ...selectRegle, user: { select: selectApporteur } }, orderBy: [{ user: { nom: "asc" } }, { lieu: { enseigne: "asc" } }] });
    const parApporteur = new Map<number, { apporteur: (typeof regles)[number]["user"]; regles: Omit<(typeof regles)[number], "user">[] }>();
    for (const { user, ...r } of regles) {
      const a = parApporteur.get(user.id) ?? { apporteur: user, regles: [] };
      a.regles.push(r);
      parApporteur.set(user.id, a);
    }
    res.json(
      await Promise.all(
        [...parApporteur.values()].map(async ({ apporteur: { keycloakSub, ...apporteur }, regles }) => ({
          apporteur: { ...apporteur, dejaConnecte: Boolean(keycloakSub) },
          regles: regles.map((r) => presenterRegle({ ...r, dateDebut: ymd(r.dateDebut), dateFin: r.dateFin ? ymd(r.dateFin) : null })),
          totaux: (await tableauDe(apporteur.id)).totaux,
        }))
      )
    );
  })
);

// GET /api/apporteurs/candidats — personnes qu'on peut désigner comme apporteur (utilisateurs actifs de la Régie)
apporteursRouter.get(
  "/candidats",
  gerer,
  asynchrone(async (_req, res) => {
    res.json(await prisma.user.findMany({ where: { isActive: true }, select: { id: true, email: true, nom: true, prenom: true }, orderBy: [{ nom: "asc" }, { prenom: "asc" }] }));
  })
);

// GET /api/apporteurs/:userId/tableau — ce que voit cet apporteur
apporteursRouter.get(
  "/:userId/tableau",
  gerer,
  asynchrone(async (req, res) => {
    const userId = Number(req.params.userId);
    const u = await prisma.user.findUnique({ where: { id: userId }, select: selectApporteur });
    if (!u) throw new HttpError(404, "INTROUVABLE");
    const { keycloakSub, ...apporteur } = u;
    res.json({ apporteur: { ...apporteur, dejaConnecte: Boolean(keycloakSub) }, ...(await tableauDe(userId)) });
  })
);

const jour = z.iso.date().transform((v) => new Date(`${v}T00:00:00Z`));
const regleSchema = z
  .object({
    userId: z.number().int().positive(),
    lieuId: z.number().int().positive(),
    // Taux en points de base (5 % = 500) ; 100 % maximum
    tauxBp: z.number().int().min(0).max(10_000),
    base: z.enum(BaseCalcul).default("TTC"),
    netRemboursements: z.boolean().default(true),
    dateDebut: jour,
    dateFin: jour.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((r) => !r.dateFin || r.dateFin >= r.dateDebut, { path: ["dateFin"], message: "La date de fin précède la date de début" });

// POST /api/apporteurs/regles — rattacher un apporteur à un lieu avec son taux
apporteursRouter.post(
  "/regles",
  gerer,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const r = regleSchema.parse(req.body);
    const [u, l] = await Promise.all([
      prisma.user.findUnique({ where: { id: r.userId }, select: { id: true } }),
      prisma.lieu.findUnique({ where: { id: r.lieuId, supprimeLe: null }, select: { id: true } }),
    ]);
    if (!u) throw new HttpError(400, "APPORTEUR_INCONNU", "Cette personne n'est pas un utilisateur de la Régie : ajoutez-la d'abord dans la page Utilisateurs.");
    if (!l) throw new HttpError(400, "LIEU_INCONNU", "Ce lieu n'existe pas");
    if (await prisma.apporteurLieu.findUnique({ where: { userId_lieuId: { userId: r.userId, lieuId: r.lieuId } } })) {
      throw new HttpError(409, "DEJA_RATTACHE", "Cet apporteur est déjà rattaché à ce lieu : modifiez sa règle.");
    }
    const regle = await prisma.apporteurLieu.create({ data: { ...r, dateFin: r.dateFin ?? null, notes: r.notes || null, creeParId: req.utilisateur!.id }, select: selectRegle });
    res.status(201).json(presenterRegle({ ...regle, dateDebut: ymd(regle.dateDebut), dateFin: regle.dateFin ? ymd(regle.dateFin) : null }));
  })
);

// PATCH /api/apporteurs/regles/:id — taux, base, dates, notes
apporteursRouter.patch(
  "/regles/:id",
  gerer,
  asynchrone(async (req, res) => {
    const id = Number(req.params.id);
    const avant = await prisma.apporteurLieu.findUnique({ where: { id } });
    if (!avant) throw new HttpError(404, "INTROUVABLE");
    const patch = regleSchema.omit({ userId: true, lieuId: true }).partial().parse(req.body);
    const dateDebut = patch.dateDebut ?? avant.dateDebut;
    const dateFin = patch.dateFin === undefined ? avant.dateFin : patch.dateFin;
    if (dateFin && dateFin < dateDebut) throw new HttpError(400, "DATES", "La date de fin précède la date de début");
    const regle = await prisma.apporteurLieu.update({ where: { id }, data: { ...patch, dateDebut, dateFin, ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}) }, select: selectRegle });
    res.json(presenterRegle({ ...regle, dateDebut: ymd(regle.dateDebut), dateFin: regle.dateFin ? ymd(regle.dateFin) : null }));
  })
);

// DELETE /api/apporteurs/regles/:id — retirer le lieu de l'apporteur (pour arrêter sans effacer l'historique : une date de fin)
apporteursRouter.delete(
  "/regles/:id",
  gerer,
  asynchrone(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.apporteurLieu.findUnique({ where: { id }, select: { id: true } }))) throw new HttpError(404, "INTROUVABLE");
    await prisma.apporteurLieu.delete({ where: { id } });
    res.status(204).end();
  })
);
