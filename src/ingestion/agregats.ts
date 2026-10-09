import { Prisma, type Encaissement, type MoyenPaiement, type TransactionStatut } from "@prisma/client";
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
  encaissement?: Encaissement | null;
}

/** Séance gratuite (schéma 1.1) : acceptée à 0 € ou sans moyen de paiement. Ni vente ni CA, mais de l'activité. */
export const estGratuite = (l: Pick<LigneAgregee, "statut" | "moyenPaiement" | "montantTtcCents">) =>
  l.statut === "ACCEPTEE" && (l.moyenPaiement === "AUCUN" || l.montantTtcCents === 0);

/** Condition SQL équivalente (table transactions). */
const GRATUITE_SQL = Prisma.sql`(statut = 'ACCEPTEE' AND (moyen_paiement = 'AUCUN' OR montant_ttc_cents = 0))`;
const VENDUE_SQL = Prisma.sql`(statut = 'ACCEPTEE' AND moyen_paiement <> 'AUCUN' AND montant_ttc_cents > 0)`;

interface Groupe {
  l: LigneAgregee;
  acc: number; ref: number; ann: number; remb: number; exp: number; off: number; grat: number;
  caTtc: number; caHt: number; rembTtc: number; rembHt: number; tirages: number; tiragesNonFactures: number;
  incertaines: number; caIncertain: number;
}

/**
 * Ajoute des transactions aux agrégats, regroupées par (jour, lieu, borne, module, moyen) :
 * une mise à jour par groupe et non par vente. Appelé dans la même transaction SQL que
 * l'insertion : une transaction compte une fois et une seule.
 * Seules les ventes payées font des ventes et du CA ; offertes et gratuites comptent à part (tirages non facturés).
 */
export async function ajouterAuxAgregats(db: Client, lignes: LigneAgregee[]) {
  const jours = new Map<string, Groupe>();
  const heures = new Map<string, { l: LigneAgregee; nb: number; ca: number }>();

  for (const l of lignes) {
    const cj = [ymd(l.jour), l.lieuId, l.borneId, l.typeModuleId, l.moyenPaiement].join("|");
    const g = jours.get(cj) ?? { l, acc: 0, ref: 0, ann: 0, remb: 0, exp: 0, off: 0, grat: 0, caTtc: 0, caHt: 0, rembTtc: 0, rembHt: 0, tirages: 0, tiragesNonFactures: 0, incertaines: 0, caIncertain: 0 };
    if (estGratuite(l)) {
      g.grat++;
      g.tiragesNonFactures += l.nbTirages;
    } else if (l.statut === "ACCEPTEE") {
      g.acc++;
      g.caTtc += l.montantTtcCents;
      g.caHt += l.montantHtCents;
      g.tirages += l.nbTirages;
      if (l.encaissement === "INCERTAIN") {
        g.incertaines++;
        g.caIncertain += l.montantTtcCents;
      }
      const ch = [ymd(l.jour), l.heure, l.lieuId, l.borneId].join("|");
      const h = heures.get(ch) ?? { l, nb: 0, ca: 0 };
      h.nb++;
      h.ca += l.montantTtcCents;
      heures.set(ch, h);
    } else if (l.statut === "REFUSEE") g.ref++;
    else if (l.statut === "ANNULEE") g.ann++;
    else if (l.statut === "EXPIREE") g.exp++;
    else if (l.statut === "OFFERTE") {
      g.off++;
      g.tiragesNonFactures += l.nbTirages;
    } else if (l.statut === "REMBOURSEE") {
      g.remb++;
      g.rembTtc += l.montantTtcCents;
      g.rembHt += l.montantHtCents;
    }
    jours.set(cj, g);
  }

  for (const g of jours.values()) {
    await db.$executeRaw`
      INSERT INTO agg_jour (jour, lieu_id, borne_id, type_module_id, moyen_paiement,
        nb_acceptees, nb_refusees, nb_annulees, nb_remboursees, nb_expirees, nb_offertes, nb_gratuites,
        ca_ttc_cents, ca_ht_cents, rembourse_ttc_cents, rembourse_ht_cents, nb_tirages, tirages_non_factures,
        nb_incertaines, ca_incertain_ttc_cents, maj_le)
      VALUES (${ymd(g.l.jour)}::date, ${g.l.lieuId}, ${g.l.borneId}, ${g.l.typeModuleId}, ${g.l.moyenPaiement}::"MoyenPaiement",
        ${g.acc}, ${g.ref}, ${g.ann}, ${g.remb}, ${g.exp}, ${g.off}, ${g.grat},
        ${g.caTtc}, ${g.caHt}, ${g.rembTtc}, ${g.rembHt}, ${g.tirages}, ${g.tiragesNonFactures},
        ${g.incertaines}, ${g.caIncertain}, now())
      ON CONFLICT (jour, lieu_id, borne_id, type_module_id, moyen_paiement) DO UPDATE SET
        nb_acceptees           = agg_jour.nb_acceptees           + EXCLUDED.nb_acceptees,
        nb_refusees            = agg_jour.nb_refusees            + EXCLUDED.nb_refusees,
        nb_annulees            = agg_jour.nb_annulees            + EXCLUDED.nb_annulees,
        nb_remboursees         = agg_jour.nb_remboursees         + EXCLUDED.nb_remboursees,
        nb_expirees            = agg_jour.nb_expirees            + EXCLUDED.nb_expirees,
        nb_offertes            = agg_jour.nb_offertes            + EXCLUDED.nb_offertes,
        nb_gratuites           = agg_jour.nb_gratuites           + EXCLUDED.nb_gratuites,
        ca_ttc_cents           = agg_jour.ca_ttc_cents           + EXCLUDED.ca_ttc_cents,
        ca_ht_cents            = agg_jour.ca_ht_cents            + EXCLUDED.ca_ht_cents,
        rembourse_ttc_cents    = agg_jour.rembourse_ttc_cents    + EXCLUDED.rembourse_ttc_cents,
        rembourse_ht_cents     = agg_jour.rembourse_ht_cents     + EXCLUDED.rembourse_ht_cents,
        nb_tirages             = agg_jour.nb_tirages             + EXCLUDED.nb_tirages,
        tirages_non_factures   = agg_jour.tirages_non_factures   + EXCLUDED.tirages_non_factures,
        nb_incertaines         = agg_jour.nb_incertaines         + EXCLUDED.nb_incertaines,
        ca_incertain_ttc_cents = agg_jour.ca_incertain_ttc_cents + EXCLUDED.ca_incertain_ttc_cents,
        maj_le                 = now()`;
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
        nb_acceptees, nb_refusees, nb_annulees, nb_remboursees, nb_expirees, nb_offertes, nb_gratuites,
        ca_ttc_cents, ca_ht_cents, rembourse_ttc_cents, rembourse_ht_cents, nb_tirages, tirages_non_factures,
        nb_incertaines, ca_incertain_ttc_cents, maj_le)
      SELECT jour_local, lieu_id, borne_id, type_module_id, moyen_paiement,
        count(*) FILTER (WHERE ${VENDUE_SQL}),
        count(*) FILTER (WHERE statut = 'REFUSEE'),
        count(*) FILTER (WHERE statut = 'ANNULEE'),
        count(*) FILTER (WHERE statut = 'REMBOURSEE'),
        count(*) FILTER (WHERE statut = 'EXPIREE'),
        count(*) FILTER (WHERE statut = 'OFFERTE'),
        count(*) FILTER (WHERE ${GRATUITE_SQL}),
        coalesce(sum(montant_ttc_cents) FILTER (WHERE ${VENDUE_SQL}), 0),
        coalesce(sum(montant_ht_cents)  FILTER (WHERE ${VENDUE_SQL}), 0),
        coalesce(sum(montant_ttc_cents) FILTER (WHERE statut = 'REMBOURSEE'), 0),
        coalesce(sum(montant_ht_cents)  FILTER (WHERE statut = 'REMBOURSEE'), 0),
        coalesce(sum(nb_tirages)        FILTER (WHERE ${VENDUE_SQL}), 0),
        coalesce(sum(nb_tirages)        FILTER (WHERE statut = 'OFFERTE' OR ${GRATUITE_SQL}), 0),
        count(*) FILTER (WHERE ${VENDUE_SQL} AND encaissement = 'INCERTAIN'),
        coalesce(sum(montant_ttc_cents) FILTER (WHERE ${VENDUE_SQL} AND encaissement = 'INCERTAIN'), 0),
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
      WHERE borne_id = ${borneId} AND lieu_id IS NOT NULL AND ${VENDUE_SQL}
        AND jour_local BETWEEN ${ymd(jourDebut)}::date AND ${ymd(jourFin)}::date
      GROUP BY 1, 2, lieu_id, borne_id`;
  });
}
