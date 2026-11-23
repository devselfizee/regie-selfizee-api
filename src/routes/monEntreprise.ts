import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { requirePerm } from "../middleware/permissions.js";
import { creerCompteClient, lieuxEntreprise, listerComptes, modifierCompteClient, profilsProposes, renvoyerInvitation } from "../comptes/comptesRegie.js";
import { corpsModifCompte, corpsNouveauCompte } from "./entreprises.js";

// « Mon entreprise » (option 2 du 20/11/2026) : un client admin gère les comptes de son entreprise, et seulement eux.
// Monté sous /api/mon-entreprise, droit comptes_entreprise.manage ; réservé aux comptes clients (realm « regie »).
export const monEntrepriseRouter = Router();
monEntrepriseRouter.use(requirePerm("comptes_entreprise.manage"));

const entrepriseDe = (req: UtilisateurRequest): number => {
  const u = req.utilisateur;
  if (u?.compte !== "REGIE" || !u.entrepriseId) throw new HttpError(403, "COMPTE_CLIENT_REQUIS", "Réservé aux comptes clients d'une entreprise.");
  return u.entrepriseId;
};
const id = (v: unknown) => z.coerce.number().int().positive().max(2_147_483_647).parse(v);

// GET /api/mon-entreprise
monEntrepriseRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const entrepriseId = entrepriseDe(req);
    const e = await prisma.entreprise.findUniqueOrThrow({ where: { id: entrepriseId }, select: { id: true, nom: true } });
    const [lieux, comptes, profils] = await Promise.all([lieuxEntreprise(entrepriseId), listerComptes(entrepriseId), profilsProposes()]);
    res.json({ ...e, lieux, comptes, profils, moiId: req.utilisateur!.id });
  })
);

// POST /api/mon-entreprise/comptes — inviter un collègue
monEntrepriseRouter.post(
  "/comptes",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const compteId = await creerCompteClient(entrepriseDe(req), corpsNouveauCompte.parse(req.body));
    res.status(201).json({ id: compteId });
  })
);

// PATCH /api/mon-entreprise/comptes/:id — profil, lieux, activation (jamais les siens propres)
monEntrepriseRouter.patch(
  "/comptes/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    await modifierCompteClient(entrepriseDe(req), id(req.params.id), corpsModifCompte.parse(req.body), req.utilisateur!.id);
    res.json({ ok: true });
  })
);

// POST /api/mon-entreprise/comptes/:id/invitation
monEntrepriseRouter.post(
  "/comptes/:id/invitation",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    await renvoyerInvitation(entrepriseDe(req), id(req.params.id));
    res.json({ ok: true });
  })
);
