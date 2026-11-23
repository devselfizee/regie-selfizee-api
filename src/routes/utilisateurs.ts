import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { requirePerm, libellesProfils, clesAccordees, diagnosticAcces } from "../middleware/permissions.js";
import { utilisateurSuperAdmin } from "../lib/superAdmin.js";
import { estCompteRegie } from "../middleware/auth.js";
import { creerCompteClient } from "../comptes/comptesRegie.js";

export const utilisateursRouter = Router();

// GET /api/utilisateurs/moi — l'utilisateur connecté (ses droits, eux, viennent du gateway Konitys)
utilisateursRouter.get(
  "/moi",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const u = req.utilisateur!;
    // Ses lieux (client) avec leur nom : le menu « Mon lieu » / « Mes lieux » sans le droit de voir la liste
    const lieux = u.lieuIds.length
      ? await prisma.lieu.findMany({ where: { id: { in: u.lieuIds }, supprimeLe: null }, select: { id: true, enseigne: true }, orderBy: { enseigne: "asc" } })
      : [];
    // Compte client (realm « regie ») : son entreprise, et ses droits (le front n'a pas le SDK du gateway pour lui)
    const regie = estCompteRegie(req);
    const entreprise = regie && u.entrepriseId ? await prisma.entreprise.findUnique({ where: { id: u.entrepriseId }, select: { id: true, nom: true } }) : null;
    // superAdmin : e-mail dans ADMIN_EMAILS (salarié), seul à pouvoir supprimer un lieu ou une borne
    res.json({
      ...u,
      compte: regie ? "REGIE" : "KONITYS",
      lieux,
      superAdmin: utilisateurSuperAdmin(u),
      ...(regie ? { entreprise, droits: await clesAccordees(req), diagnostic: await diagnosticAcces(req) } : {}),
    });
  })
);

const select = {
  id: true, email: true, nom: true, prenom: true, telephone: true, alertesSms: true, alertesEmail: true, isActive: true,
  keycloakSub: true, createdAt: true, profilsHub: true, adminPlateforme: true, profilsRelevesLe: true,
  // Lieux auxquels un client a accès (demande du 17/11 : un ou plusieurs lieux)
  accesLieux: { select: { lieu: { select: { id: true, enseigne: true } } }, orderBy: { lieu: { enseigne: "asc" } } },
  _count: { select: { lieuxCommercial: true, apports: true } },
} as const;

/** Réponse de la page Utilisateurs : les lieux à plat, et si la personne est apporteur d'affaires */
const presenter = <U extends { accesLieux: { lieu: { id: number; enseigne: string } }[]; _count: { lieuxCommercial: number; apports: number } }>(u: U) => {
  const { accesLieux, _count, ...reste } = u;
  return { ...reste, lieux: accesLieux.map((a) => a.lieu), lieuIds: accesLieux.map((a) => a.lieu.id), nbLieux: _count.lieuxCommercial, apporteur: _count.apports > 0 };
};

// GET /api/utilisateurs
utilisateursRouter.get(
  "/",
  requirePerm("utilisateurs.manage"),
  asynchrone(async (req, res) => {
    const [users, libelles] = await Promise.all([
      // Salariés et anciens clients Konitys ; les comptes clients de la Régie sont dans leur entreprise
      prisma.user.findMany({ where: { compte: "KONITYS" }, orderBy: [{ isActive: "desc" }, { nom: "asc" }], select }),
      libellesProfils(req),
    ]);
    res.json(
      users.map(presenter).map(({ keycloakSub, profilsHub, ...u }) => ({
        ...u,
        dejaConnecte: Boolean(keycloakSub),
        // Profils de l'Admin Panel, par leur nom quand la liste est lisible, sinon par leur numéro
        profils: profilsHub.map((id) => libelles[id] ?? `Profil n° ${id}`),
      }))
    );
  })
);

// Identité depuis Keycloak, droits depuis l'Admin Panel Konitys : la Régie ne gère ici que l'accès
// (ajout, désactivation), les lieux d'un client et les SMS des alertes.
const base = { lieuIds: z.array(z.number().int().positive()).max(500).optional() };

/** Les lieux demandés existent (et ne sont pas supprimés), sans doublon */
async function lieuxValides(lieuIds: number[]): Promise<number[]> {
  const ids = [...new Set(lieuIds)];
  if (!ids.length) return [];
  const existants = await prisma.lieu.findMany({ where: { id: { in: ids }, supprimeLe: null }, select: { id: true } });
  if (existants.length !== ids.length) throw new HttpError(400, "LIEU_INCONNU", "Un des lieux n'existe pas");
  return ids;
}

// POST /api/utilisateurs — ajouter une personne (elle se connecte ensuite avec son compte Keycloak, même e-mail)
utilisateursRouter.post(
  "/",
  requirePerm("utilisateurs.manage"),
  asynchrone(async (req, res) => {
    const data = z.object({ email: z.email().transform((e) => e.toLowerCase()), ...base }).parse(req.body);
    const lieuIds = await lieuxValides(data.lieuIds ?? []);
    const u = await prisma.user.create({
      // L'e-mail tient lieu de nom jusqu'à la première connexion, qui reprend celui de Keycloak
      data: { email: data.email, nom: data.email, prenom: "", accesLieux: { create: lieuIds.map((lieuId) => ({ lieuId })) } },
      select,
    });
    res.status(201).json(presenter(u));
  })
);

// PATCH /api/utilisateurs/:id — lieux du client, SMS des alertes, désactivation (jamais l'identité ni les droits)
utilisateursRouter.patch(
  "/:id",
  requirePerm("utilisateurs.manage"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = Number(req.params.id);
    const { lieuIds, ...patch } = z.object({ ...base, isActive: z.boolean().optional(), alertesSms: z.boolean().optional(), alertesEmail: z.boolean().optional() }).parse(req.body);
    await prisma.user.findFirstOrThrow({ where: { id, compte: "KONITYS" }, select: { id: true } });

    // Éviter de se couper soi-même l'accès
    if (id === req.utilisateur?.id && patch.isActive === false) {
      throw new HttpError(400, "AUTO_RETRAIT", "Vous ne pouvez pas désactiver votre propre compte");
    }

    // Lieux : la liste envoyée remplace l'ancienne
    const acces = lieuIds === undefined ? undefined : await lieuxValides(lieuIds);
    const u = await prisma.user.update({
      where: { id },
      data: { ...patch, ...(acces ? { accesLieux: { deleteMany: {}, create: acces.map((lieuId) => ({ lieuId })) } } : {}) },
      select,
    });
    res.json(presenter(u));
  })
);

// POST /api/utilisateurs/:id/passer-client — un ancien client Konitys (realm konitys, avec des lieux) devient un compte
// client de la Régie : compte créé dans l'entreprise avec les mêmes lieux (rattachés à l'entreprise s'ils n'en ont
// pas), invitation envoyée, ancien compte désactivé. Option 2 du 20/11/2026.
utilisateursRouter.post(
  "/:id/passer-client",
  requirePerm("utilisateurs.manage"),
  requirePerm("entreprises.manage"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const id = Number(req.params.id);
    const d = z.object({ entrepriseId: z.number().int().positive(), profilId: z.number().int().positive() }).parse(req.body);
    const ancien = await prisma.user.findFirst({
      where: { id, compte: "KONITYS" },
      select: { id: true, email: true, nom: true, prenom: true, accesLieux: { select: { lieu: { select: { id: true, enseigne: true, entrepriseId: true } } } } },
    });
    if (!ancien) throw new HttpError(404, "INTROUVABLE");
    if (id === req.utilisateur?.id) throw new HttpError(400, "AUTO_RETRAIT", "Vous ne pouvez pas convertir votre propre compte.");
    const lieux = ancien.accesLieux.map((a) => a.lieu);
    const ailleurs = lieux.find((l) => l.entrepriseId && l.entrepriseId !== d.entrepriseId);
    if (ailleurs) throw new HttpError(409, "LIEU_AUTRE_ENTREPRISE", `${ailleurs.enseigne} appartient déjà à une autre entreprise.`);
    await prisma.lieu.updateMany({ where: { id: { in: lieux.map((l) => l.id) }, entrepriseId: null }, data: { entrepriseId: d.entrepriseId } });
    // Le nom tient lieu d'e-mail tant que la personne ne s'est jamais connectée : on ne le recopie pas
    const nom = ancien.nom && ancien.nom !== ancien.email ? ancien.nom : ancien.email.split("@")[0];
    const compteId = await creerCompteClient(d.entrepriseId, { email: ancien.email, prenom: ancien.prenom || "-", nom, profilId: d.profilId, lieuIds: lieux.map((l) => l.id) });
    await prisma.user.update({ where: { id }, data: { isActive: false } });
    res.status(201).json({ id: compteId });
  })
);
