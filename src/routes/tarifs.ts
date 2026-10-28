import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { exiger, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { erreursGrille, GRILLE_DEFAUT, grilleBase, grilleEffective, grilleLieu, grilleSchema, type Grille } from "../tarifs/grille.js";

// Tarifs en trois niveaux (demande de Sébastien, 28/10/2026) : base du parc → lieu → événement.

function valider(brut: unknown): Grille {
  const g = grilleSchema.parse(brut);
  const erreurs = erreursGrille(g);
  if (erreurs.length) throw new HttpError(400, "GRILLE_INVALIDE", erreurs.join(" "));
  return g;
}

export const tarifsRouter = Router();

// GET /api/tarifs/base — tarifs de base du parc (grille d'usine tant qu'ils ne sont pas saisis)
tarifsRouter.get(
  "/base",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone(async (_req, res) => {
    const g = await prisma.grilleTarifs.findFirst({ where: { lieuId: null }, include: { majPar: { select: { prenom: true, nom: true } } } });
    res.json({
      grille: g ? grilleSchema.parse(g.grille) : GRILLE_DEFAUT,
      saisie: Boolean(g),
      majLe: g?.updatedAt ?? null,
      majPar: g?.majPar ?? null,
      nbLieuxPropres: await prisma.grilleTarifs.count({ where: { lieuId: { not: null } } }),
    });
  })
);

// PUT /api/tarifs/base { grille } — admins
tarifsRouter.put(
  "/base",
  exiger("ADMIN"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const grille = valider(z.object({ grille: z.unknown() }).parse(req.body).grille);
    const existante = await prisma.grilleTarifs.findFirst({ where: { lieuId: null } });
    if (existante) await prisma.grilleTarifs.update({ where: { id: existante.id }, data: { grille, majParId: req.utilisateur!.id } });
    else await prisma.grilleTarifs.create({ data: { lieuId: null, grille, majParId: req.utilisateur!.id } });
    await prisma.auditLog.create({ data: { userId: req.utilisateur!.id, entite: "tarifs_base", entiteId: "-", action: "MODIFICATION", avant: existante?.grille ?? undefined, apres: grille } });
    res.json({ grille, saisie: true });
  })
);

export const tarifsLieuRouter = Router();

// GET /api/lieux/:id/tarifs — tarifs propres au lieu (ou null), tarifs de base, et ceux qui s'appliquent
tarifsLieuRouter.get(
  "/:id/tarifs",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const [propre, base, effective] = await Promise.all([grilleLieu(lieuId), grilleBase(), grilleEffective(lieuId)]);
    res.json({ propre, base: base ?? GRILLE_DEFAUT, effective });
  })
);

// PUT /api/lieux/:id/tarifs { grille | null } — null : le lieu reprend les tarifs de base
tarifsLieuRouter.put(
  "/:id/tarifs",
  exiger("ADMIN", "COMMERCIAL"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const brut = z.object({ grille: z.unknown().nullable() }).parse(req.body).grille;
    const avant = await grilleLieu(lieuId);
    if (brut === null) {
      await prisma.grilleTarifs.deleteMany({ where: { lieuId } });
    } else {
      const grille = valider(brut);
      await prisma.grilleTarifs.upsert({ where: { lieuId }, create: { lieuId, grille, majParId: req.utilisateur!.id }, update: { grille, majParId: req.utilisateur!.id } });
    }
    await prisma.auditLog.create({
      data: { userId: req.utilisateur!.id, entite: "lieu", entiteId: String(lieuId), action: "TARIFS", avant: avant ?? undefined, apres: brut === null ? { herite: true } : (brut as object) },
    });
    const [propre, base, effective] = await Promise.all([grilleLieu(lieuId), grilleBase(), grilleEffective(lieuId)]);
    res.json({ propre, base: base ?? GRILLE_DEFAUT, effective });
  })
);
