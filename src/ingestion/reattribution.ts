import { prisma } from "../lib/prisma.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { recalculerAgregats } from "./agregats.js";

const FIN_DES_TEMPS = new Date("2100-01-01T00:00:00Z");

/**
 * Après création / modification / suppression d'une affectation : rattache à
 * nouveau les transactions de la borne sur [debut, fin) au lieu actif à leur
 * date, puis reconstruit les agrégats des jours concernés.
 */
export async function reattribuerTransactions(borneId: number, debut: Date, fin: Date | null) {
  const borneFin = fin ?? FIN_DES_TEMPS;

  await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE transactions SET lieu_id = NULL, affectation_id = NULL
      WHERE borne_id = ${borneId} AND horodatage >= ${debut} AND horodatage < ${borneFin}`,
    prisma.$executeRaw`
      UPDATE transactions t SET lieu_id = a.lieu_id, affectation_id = a.id
      FROM affectations_borne a
      WHERE t.borne_id = ${borneId} AND a.borne_id = t.borne_id
        AND t.horodatage >= ${debut} AND t.horodatage < ${borneFin}
        AND t.horodatage >= a.debut AND (a.fin IS NULL OR t.horodatage < a.fin)`,
  ]);

  await recalculerAgregats(borneId, jourEtHeureLocaux(debut).jour, jourEtHeureLocaux(borneFin).jour);

  // Les alertes "borne non affectée" dont toutes les ventes ont trouvé un lieu sont résolues
  const restantes = await prisma.$queryRaw<{ jour: Date }[]>`
    SELECT DISTINCT jour_local AS jour FROM transactions WHERE borne_id = ${borneId} AND lieu_id IS NULL`;
  const joursRestants = new Set(restantes.map((r) => `BORNE_NON_AFFECTEE:${borneId}:${r.jour.toISOString().slice(0, 10)}`));
  const ouvertes = await prisma.alerte.findMany({
    where: { borneId, type: "BORNE_NON_AFFECTEE", statut: { in: ["NOUVELLE", "PRISE_EN_CHARGE"] } },
    select: { id: true, cleDedup: true },
  });
  const aResoudre = ouvertes.filter((a) => !joursRestants.has(a.cleDedup)).map((a) => a.id);
  if (aResoudre.length) {
    await prisma.alerte.updateMany({
      where: { id: { in: aResoudre } },
      data: { statut: "RESOLUE", resolueLe: new Date(), commentaire: "Résolue automatiquement : borne affectée" },
    });
  }
}
