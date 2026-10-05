import { Prisma, type MoyenPaiement, type TransactionStatut } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type Client = Prisma.TransactionClient | typeof prisma;

// Dates passées en texte : le cast ::date ne dépend pas du fuseau de la session SQL
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface LigneAgregee {
  jour: Date;
  heure: number;
  lieuId: number;
  borneId: number;
  typeModuleId: number;
  moyenPaiement: MoyenPaiement;
  statut: TransactionStatut;
  montantTtcCents: number;
  montantHtCents: number;
  nbTirages: number;
}

/**
 * Ajoute une transaction aux agrégats. Appelé dans la même transaction SQL que
 * l'insertion : une transaction compte une fois et une seule.
 */
export async function incrementerAgregats(db: Client, l: LigneAgregee) {
  const acceptee = l.statut === "ACCEPTEE";
  const remboursee = l.statut === "REMBOURSEE";

  await db.$executeRaw`
    INSERT INTO agg_jour (jour, lieu_id, borne_id, type_module_id, moyen_paiement,
      nb_acceptees, nb_refusees, nb_annulees, nb_remboursees,
      ca_ttc_cents, ca_ht_cents, rembourse_ttc_cents, rembourse_ht_cents, nb_tirages, maj_le)
    VALUES (${ymd(l.jour)}::date, ${l.lieuId}, ${l.borneId}, ${l.typeModuleId}, ${l.moyenPaiement}::"MoyenPaiement",
      ${acceptee ? 1 : 0}, ${l.statut === "REFUSEE" ? 1 : 0}, ${l.statut === "ANNULEE" ? 1 : 0}, ${remboursee ? 1 : 0},
      ${acceptee ? l.montantTtcCents : 0}, ${acceptee ? l.montantHtCents : 0},
      ${remboursee ? l.montantTtcCents : 0}, ${remboursee ? l.montantHtCents : 0},
      ${acceptee ? l.nbTirages : 0}, now())
    ON CONFLICT (jour, lieu_id, borne_id, type_module_id, moyen_paiement) DO UPDATE SET
      nb_acceptees        = agg_jour.nb_acceptees        + EXCLUDED.nb_acceptees,
      nb_refusees         = agg_jour.nb_refusees         + EXCLUDED.nb_refusees,
      nb_annulees         = agg_jour.nb_annulees         + EXCLUDED.nb_annulees,
      nb_remboursees      = agg_jour.nb_remboursees      + EXCLUDED.nb_remboursees,
      ca_ttc_cents        = agg_jour.ca_ttc_cents        + EXCLUDED.ca_ttc_cents,
      ca_ht_cents         = agg_jour.ca_ht_cents         + EXCLUDED.ca_ht_cents,
      rembourse_ttc_cents = agg_jour.rembourse_ttc_cents + EXCLUDED.rembourse_ttc_cents,
      rembourse_ht_cents  = agg_jour.rembourse_ht_cents  + EXCLUDED.rembourse_ht_cents,
      nb_tirages          = agg_jour.nb_tirages          + EXCLUDED.nb_tirages,
      maj_le              = now()`;

  if (acceptee) {
    await db.$executeRaw`
      INSERT INTO agg_heure (jour, heure, lieu_id, borne_id, nb_acceptees, ca_ttc_cents)
      VALUES (${ymd(l.jour)}::date, ${l.heure}, ${l.lieuId}, ${l.borneId}, 1, ${l.montantTtcCents})
      ON CONFLICT (jour, heure, lieu_id, borne_id) DO UPDATE SET
        nb_acceptees = agg_heure.nb_acceptees + 1,
        ca_ttc_cents = agg_heure.ca_ttc_cents + EXCLUDED.ca_ttc_cents`;
  }
}

/**
 * Reconstruit les agrégats d'une borne sur une plage de jours à partir des
 * transactions (après correction d'une affectation, ou pour vérification).
 */
export async function recalculerAgregats(borneId: number, jourDebut: Date, jourFin: Date) {
  await prisma.$transaction(async (db) => {
    await db.$executeRaw`DELETE FROM agg_jour  WHERE borne_id = ${borneId} AND jour BETWEEN ${ymd(jourDebut)}::date AND ${ymd(jourFin)}::date`;
    await db.$executeRaw`DELETE FROM agg_heure WHERE borne_id = ${borneId} AND jour BETWEEN ${ymd(jourDebut)}::date AND ${ymd(jourFin)}::date`;

    await db.$executeRaw`
      INSERT INTO agg_jour (jour, lieu_id, borne_id, type_module_id, moyen_paiement,
        nb_acceptees, nb_refusees, nb_annulees, nb_remboursees,
        ca_ttc_cents, ca_ht_cents, rembourse_ttc_cents, rembourse_ht_cents, nb_tirages, maj_le)
      SELECT jour_local, lieu_id, borne_id, type_module_id, moyen_paiement,
        count(*) FILTER (WHERE statut = 'ACCEPTEE'),
        count(*) FILTER (WHERE statut = 'REFUSEE'),
        count(*) FILTER (WHERE statut = 'ANNULEE'),
        count(*) FILTER (WHERE statut = 'REMBOURSEE'),
        coalesce(sum(montant_ttc_cents) FILTER (WHERE statut = 'ACCEPTEE'), 0),
        coalesce(sum(montant_ht_cents)  FILTER (WHERE statut = 'ACCEPTEE'), 0),
        coalesce(sum(montant_ttc_cents) FILTER (WHERE statut = 'REMBOURSEE'), 0),
        coalesce(sum(montant_ht_cents)  FILTER (WHERE statut = 'REMBOURSEE'), 0),
        coalesce(sum(nb_tirages)        FILTER (WHERE statut = 'ACCEPTEE'), 0),
        now()
      FROM transactions
      WHERE borne_id = ${borneId} AND lieu_id IS NOT NULL
        AND jour_local BETWEEN ${ymd(jourDebut)}::date AND ${ymd(jourFin)}::date
      GROUP BY jour_local, lieu_id, borne_id, type_module_id, moyen_paiement`;

    await db.$executeRaw`
      INSERT INTO agg_heure (jour, heure, lieu_id, borne_id, nb_acceptees, ca_ttc_cents)
      SELECT jour_local,
        extract(hour FROM horodatage AT TIME ZONE 'Europe/Paris')::int,
        lieu_id, borne_id, count(*), sum(montant_ttc_cents)
      FROM transactions
      WHERE borne_id = ${borneId} AND lieu_id IS NOT NULL AND statut = 'ACCEPTEE'
        AND jour_local BETWEEN ${ymd(jourDebut)}::date AND ${ymd(jourFin)}::date
      GROUP BY 1, 2, lieu_id, borne_id`;
  });
}
