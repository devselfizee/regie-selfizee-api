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
 * Ajoute des transactions aux agrégats, regroupées par (jour, lieu, borne, module, moyen) :
 * une mise à jour par groupe et non par vente. Appelé dans la même transaction SQL que
 * l'insertion : une transaction compte une fois et une seule.
 */
export async function ajouterAuxAgregats(db: Client, lignes: LigneAgregee[]) {
  const jours = new Map<string, { l: LigneAgregee; acc: number; ref: number; ann: number; remb: number; caTtc: number; caHt: number; rembTtc: number; rembHt: number; tirages: number }>();
  const heures = new Map<string, { l: LigneAgregee; nb: number; ca: number }>();

  for (const l of lignes) {
    const cj = [ymd(l.jour), l.lieuId, l.borneId, l.typeModuleId, l.moyenPaiement].join("|");
    const g = jours.get(cj) ?? { l, acc: 0, ref: 0, ann: 0, remb: 0, caTtc: 0, caHt: 0, rembTtc: 0, rembHt: 0, tirages: 0 };
    if (l.statut === "ACCEPTEE") {
      g.acc++;
      g.caTtc += l.montantTtcCents;
      g.caHt += l.montantHtCents;
      g.tirages += l.nbTirages;
      const ch = [ymd(l.jour), l.heure, l.lieuId, l.borneId].join("|");
      const h = heures.get(ch) ?? { l, nb: 0, ca: 0 };
      h.nb++;
      h.ca += l.montantTtcCents;
      heures.set(ch, h);
    } else if (l.statut === "REFUSEE") g.ref++;
    else if (l.statut === "ANNULEE") g.ann++;
    else if (l.statut === "REMBOURSEE") {
      g.remb++;
      g.rembTtc += l.montantTtcCents;
      g.rembHt += l.montantHtCents;
    }
    jours.set(cj, g);
  }

  for (const g of jours.values()) {
    await db.$executeRaw`
      INSERT INTO agg_jour (jour, lieu_id, borne_id, type_module_id, moyen_paiement,
        nb_acceptees, nb_refusees, nb_annulees, nb_remboursees,
        ca_ttc_cents, ca_ht_cents, rembourse_ttc_cents, rembourse_ht_cents, nb_tirages, maj_le)
      VALUES (${ymd(g.l.jour)}::date, ${g.l.lieuId}, ${g.l.borneId}, ${g.l.typeModuleId}, ${g.l.moyenPaiement}::"MoyenPaiement",
        ${g.acc}, ${g.ref}, ${g.ann}, ${g.remb}, ${g.caTtc}, ${g.caHt}, ${g.rembTtc}, ${g.rembHt}, ${g.tirages}, now())
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
  }

  for (const h of heures.values()) {
    await db.$executeRaw`
      INSERT INTO agg_heure (jour, heure, lieu_id, borne_id, nb_acceptees, ca_ttc_cents)
      VALUES (${ymd(h.l.jour)}::date, ${h.l.heure}, ${h.l.lieuId}, ${h.l.borneId}, ${h.nb}, ${h.ca})
      ON CONFLICT (jour, heure, lieu_id, borne_id) DO UPDATE SET
        nb_acceptees = agg_heure.nb_acceptees + EXCLUDED.nb_acceptees,
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
