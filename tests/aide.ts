import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma.js";

export const exemple = (nom: string) =>
  JSON.parse(readFileSync(new URL(`../schemas/examples/${nom}`, import.meta.url), "utf8"));

// DELETE plutôt que TRUNCATE : TRUNCATE prend ~12 s sur Postgres sous Docker Desktop (Windows)
export async function viderBase() {
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.reversementAjustement.deleteMany(),
    prisma.reversement.deleteMany(),
    prisma.contratPalier.deleteMany(),
    prisma.contratCommission.deleteMany(),
    prisma.aggJour.deleteMany(),
    prisma.aggHeure.deleteMany(),
    prisma.notificationAlerte.deleteMany(),
    prisma.alerte.deleteMany(),
    prisma.transaction.deleteMany(),
    prisma.importErreur.deleteMany(),
    prisma.importLot.deleteMany(),
    prisma.heartbeat.deleteMany(),
    prisma.affectationBorne.deleteMany(),
    prisma.modulePaiement.deleteMany(),
    prisma.borne.deleteMany(),
    prisma.user.updateMany({ data: { lieuId: null } }),
    prisma.lieu.deleteMany(),
    prisma.user.deleteMany(),
    prisma.refValeur.deleteMany({ where: { parentId: { not: null } } }),
    prisma.refValeur.deleteMany(),
    prisma.gamme.deleteMany(),
    prisma.typeModulePaiement.deleteMany(),
  ]);
}
