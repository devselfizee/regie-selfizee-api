import type { UserRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma.js";

// Réglages des comptes, modifiables dans Paramètres (retour du 06/11/2026 : les noms changent, pas besoin de redéployer) :
// rôles Keycloak qui donnent chaque rôle de la Régie, et champs du téléphone dans la fiche Hub.
// Sans réglage enregistré : les variables d'environnement, sinon les valeurs par défaut.

const CLE = "comptes";
const liste = (brut: string) => brut.split(/[,;\n]+/).map((r) => r.trim().toLowerCase()).filter(Boolean);

export const reglagesComptesSchema = z.object({
  roles: z.object({
    ADMIN: z.array(z.string().trim().min(1).max(100)).max(50),
    TECHNICIEN: z.array(z.string().trim().min(1).max(100)).max(50),
    COMMERCIAL: z.array(z.string().trim().min(1).max(100)).max(50),
    PARTENAIRE: z.array(z.string().trim().min(1).max(100)).max(50),
  }),
  champsTelephone: z.array(z.string().trim().min(1).max(100)).max(20),
});
export type ReglagesComptes = z.infer<typeof reglagesComptesSchema>;

export const reglagesComptesDefaut = (): ReglagesComptes => ({
  roles: {
    ADMIN: liste(process.env.KEYCLOAK_ROLES_ADMIN || "admin,administrateur,administrator,super-admin,super_admin,superadmin"),
    TECHNICIEN: liste(process.env.KEYCLOAK_ROLES_TECHNICIEN || "technicien,installateur,regie-technicien"),
    COMMERCIAL: liste(process.env.KEYCLOAK_ROLES_COMMERCIAL || "commercial,konitys commercial,konitys-commercial,konitys_commercial,regie-commercial"),
    PARTENAIRE: liste(process.env.KEYCLOAK_ROLES_PARTENAIRE || "partenaire,regie-partenaire"),
  },
  champsTelephone: (process.env.KONITYS_CHAMPS_TELEPHONE || "telephone,tel,phone,phone_number,mobile,portable,telephone_portable,telephone_mobile")
    .split(/[,;\s]+/)
    .filter(Boolean),
});

// Lu à chaque requête authentifiée : gardé une minute en mémoire
let cache: { valeur: ReglagesComptes; le: number } | null = null;

export async function reglagesComptes(): Promise<ReglagesComptes> {
  if (cache && Date.now() - cache.le < 60_000) return cache.valeur;
  const ligne = await prisma.reglageApplication.findUnique({ where: { cle: CLE } }).catch(() => null);
  const lu = ligne ? reglagesComptesSchema.safeParse(ligne.valeur) : null;
  const valeur = lu?.success ? normaliser(lu.data) : reglagesComptesDefaut();
  cache = { valeur, le: Date.now() };
  return valeur;
}

/** Rôles en minuscules et sans doublon (la comparaison avec le jeton ignore la casse) */
function normaliser(r: ReglagesComptes): ReglagesComptes {
  const net = (l: string[]) => [...new Set(l.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  return {
    roles: Object.fromEntries(Object.entries(r.roles).map(([k, v]) => [k, net(v)])) as Record<UserRole, string[]>,
    champsTelephone: [...new Set(r.champsTelephone.map((x) => x.trim()).filter(Boolean))],
  };
}

export async function enregistrerReglagesComptes(r: ReglagesComptes, userId: number | null) {
  const valeur = normaliser(r);
  await prisma.reglageApplication.upsert({ where: { cle: CLE }, update: { valeur }, create: { cle: CLE, valeur } });
  await prisma.auditLog.create({ data: { userId, entite: "reglages", entiteId: CLE, action: "MODIFICATION", apres: valeur } });
  cache = { valeur, le: Date.now() };
  return valeur;
}
