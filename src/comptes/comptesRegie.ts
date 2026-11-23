// Comptes clients de la Régie (realm Keycloak « regie », option 2 du 20/11/2026), rangés par entreprise.
// Utilisé par la page Entreprises (salariés, entreprises.manage) et par « Mon entreprise » (client admin,
// comptes_entreprise.manage) : mêmes règles, seul le périmètre change (une entreprise imposée pour le client admin).

import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import { activerCompte, creerCompte, envoyerInvitation } from "../lib/keycloakRegie.js";
import { libellesProfilsService, profilsClientsAutorises } from "../permissions/droitsProfils.js";

export const selectCompte = {
  id: true, email: true, nom: true, prenom: true, isActive: true, profilId: true, keycloakSub: true, invitationEnvoyeeLe: true, createdAt: true,
  accesLieux: { select: { lieuId: true } },
} as const;

type CompteBrut = { accesLieux: { lieuId: number }[]; keycloakSub: string | null } & Record<string, unknown>;

/** Compte pour l'affichage : ses lieux cochés (aucun = tous ceux de l'entreprise) */
export const presenterCompte = <C extends CompteBrut>(c: C) => {
  const { accesLieux, keycloakSub: _sub, ...reste } = c;
  return { ...reste, lieuIds: accesLieux.map((a) => a.lieuId) };
};

/** Profils qu'on peut attribuer à un compte client, avec leur nom (REGIE_PROFILS_CLIENTS, noms lus dans l'Admin Panel) */
export async function profilsProposes(libellesSecours: Record<number, string> = {}): Promise<{ id: number; libelle: string }[]> {
  const ids = profilsClientsAutorises();
  if (!ids.length) return [];
  const libelles = { ...libellesSecours, ...(await libellesProfilsService()) };
  return ids.map((id) => ({ id, libelle: libelles[id] ?? `Profil n° ${id}` }));
}

function verifierProfil(profilId: number) {
  const autorises = profilsClientsAutorises();
  if (!autorises.length) throw new HttpError(503, "PROFILS_CLIENTS_NON_CONFIGURES", "Aucun profil client n'est configuré (REGIE_PROFILS_CLIENTS).");
  if (!autorises.includes(profilId)) throw new HttpError(400, "PROFIL_NON_AUTORISE", "Ce profil ne peut pas être attribué à un compte client.");
}

/** Les lieux cochés appartiennent à l'entreprise, sans doublon */
async function lieuxDeLEntreprise(entrepriseId: number, lieuIds: number[]): Promise<number[]> {
  const ids = [...new Set(lieuIds)];
  if (!ids.length) return [];
  const n = await prisma.lieu.count({ where: { id: { in: ids }, entrepriseId, supprimeLe: null } });
  if (n !== ids.length) throw new HttpError(400, "LIEU_HORS_ENTREPRISE", "Un des lieux n'appartient pas à cette entreprise.");
  return ids;
}

export async function listerComptes(entrepriseId: number) {
  const comptes = await prisma.user.findMany({
    where: { compte: "REGIE", entrepriseId },
    orderBy: [{ isActive: "desc" }, { nom: "asc" }, { email: "asc" }],
    select: selectCompte,
  });
  return comptes.map(presenterCompte);
}

export interface NouveauCompte {
  email: string;
  prenom: string;
  nom: string;
  profilId: number;
  lieuIds: number[];
}

/** Crée le compte dans la Régie et dans Keycloak, puis envoie l'invitation (choix du mot de passe) */
export async function creerCompteClient(entrepriseId: number, d: NouveauCompte) {
  verifierProfil(d.profilId);
  const entreprise = await prisma.entreprise.findUnique({ where: { id: entrepriseId }, select: { actif: true } });
  if (!entreprise) throw new HttpError(404, "INTROUVABLE");
  if (!entreprise.actif) throw new HttpError(400, "ENTREPRISE_INACTIVE", "Cette entreprise est désactivée.");
  const lieuIds = await lieuxDeLEntreprise(entrepriseId, d.lieuIds);
  const email = d.email.trim().toLowerCase();
  const existant = await prisma.user.findUnique({ where: { compte_email: { compte: "REGIE", email } }, select: { entrepriseId: true } });
  if (existant) {
    throw new HttpError(409, "COMPTE_EXISTANT", existant.entrepriseId === entrepriseId ? "Ce compte existe déjà dans l'entreprise." : "Cette adresse a déjà un compte client, dans une autre entreprise.");
  }
  const keycloakSub = await creerCompte({ email, prenom: d.prenom.trim(), nom: d.nom.trim() });
  const compte = await prisma.user.create({
    data: {
      compte: "REGIE", email, prenom: d.prenom.trim(), nom: d.nom.trim(), keycloakSub, entrepriseId, profilId: d.profilId,
      role: "PARTENAIRE", accesLieux: { create: lieuIds.map((lieuId) => ({ lieuId })) },
    },
    select: { id: true },
  });
  await inviter(compte.id, keycloakSub);
  return compte.id;
}

async function inviter(id: number, keycloakSub: string) {
  await envoyerInvitation(keycloakSub);
  await prisma.user.update({ where: { id }, data: { invitationEnvoyeeLe: new Date() } });
}

async function compteDeLEntreprise(entrepriseId: number, id: number) {
  const c = await prisma.user.findFirst({ where: { id, compte: "REGIE", entrepriseId }, select: { id: true, keycloakSub: true, isActive: true } });
  if (!c) throw new HttpError(404, "INTROUVABLE");
  return c;
}

export async function renvoyerInvitation(entrepriseId: number, id: number) {
  const c = await compteDeLEntreprise(entrepriseId, id);
  if (!c.keycloakSub) throw new HttpError(400, "COMPTE_SANS_KEYCLOAK", "Ce compte n'a pas de compte Keycloak.");
  if (!c.isActive) throw new HttpError(400, "COMPTE_DESACTIVE", "Réactivez le compte avant de renvoyer l'invitation.");
  await inviter(c.id, c.keycloakSub);
}

/**
 * Profil, lieux, activation. `auteurId` : la personne qui modifie, si c'est un compte de l'entreprise (client admin) :
 * elle ne peut ni se désactiver ni changer son propre profil (pour ne pas se couper l'accès).
 */
export async function modifierCompteClient(entrepriseId: number, id: number, p: { profilId?: number; lieuIds?: number[]; isActive?: boolean }, auteurId?: number) {
  const c = await compteDeLEntreprise(entrepriseId, id);
  if (auteurId === id && (p.isActive === false || p.profilId !== undefined)) {
    throw new HttpError(400, "AUTO_RETRAIT", "Vous ne pouvez pas désactiver votre propre compte ni changer votre profil.");
  }
  if (p.profilId !== undefined) verifierProfil(p.profilId);
  const lieuIds = p.lieuIds === undefined ? undefined : await lieuxDeLEntreprise(entrepriseId, p.lieuIds);
  if (p.isActive !== undefined && p.isActive !== c.isActive && c.keycloakSub) await activerCompte(c.keycloakSub, p.isActive);
  await prisma.user.update({
    where: { id },
    data: {
      ...(p.profilId !== undefined ? { profilId: p.profilId } : {}),
      ...(p.isActive !== undefined ? { isActive: p.isActive } : {}),
      ...(lieuIds ? { accesLieux: { deleteMany: {}, create: lieuIds.map((lieuId) => ({ lieuId })) } } : {}),
    },
  });
}

/** Lieux de l'entreprise (pour cocher ceux d'un compte) */
export const lieuxEntreprise = (entrepriseId: number) =>
  prisma.lieu.findMany({ where: { entrepriseId, supprimeLe: null }, select: { id: true, enseigne: true, ville: true }, orderBy: { enseigne: "asc" } });
