import { Router, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { conditionsLieu, conditionsVentes, et, ymd, type Filtres } from "../stats/filtres.js";
import { envoyerClasseur, euros as eurosExcel, type Colonne } from "../lib/excel.js";
import { classement, filtresAutorises } from "./stats.js";

// Exports des ventes et du classement (CDC §5 : « s'exporter en CSV / Excel »).
// CSV : séparateur ; et BOM UTF-8, s'ouvre directement dans Excel FR.
export const exportRouter = Router();

interface LigneVente {
  id: bigint;
  horodatage: Date;
  enseigne: string;
  ville: string | null;
  identifiant: string;
  gamme: string;
  module: string;
  moyen: string;
  statut: string;
  montant_ttc_cents: number;
  montant_ht_cents: number;
  produit: string;
  nb_tirages: number;
  transaction_id_module: string;
}

/** Ventes filtrées, par lots de 5 000 (pagination par id) : gros volumes sans tout charger. */
async function* lotsDeVentes(f: Filtres): AsyncGenerator<LigneVente[]> {
  let dernierId = 0n;
  for (;;) {
    const lignes = await prisma.$queryRaw<LigneVente[]>`
      SELECT a.id, a.horodatage, l.enseigne, l.ville, b.identifiant, g.libelle gamme, tm.libelle module,
             a.moyen_paiement::text moyen, a.statut::text statut, a.montant_ttc_cents, a.montant_ht_cents,
             coalesce(a.produit_libelle, a.produit_code) produit, a.nb_tirages, a.transaction_id_module
      FROM transactions a
      JOIN lieux l ON l.id = a.lieu_id
      JOIN bornes b ON b.id = a.borne_id
      JOIN gammes g ON g.id = b.gamme_id
      JOIN types_module_paiement tm ON tm.id = a.type_module_id
      WHERE a.id > ${dernierId} AND ${et([...conditionsVentes(f, "a.jour_local"), ...conditionsLieu(f)])}
      ORDER BY a.id LIMIT 5000`;
    if (!lignes.length) return;
    yield lignes;
    dernierId = lignes[lignes.length - 1].id;
  }
}

// Date et heure de Paris d'un instant
const paris = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const enParis = (d: Date) => {
  const p = Object.fromEntries(paris.formatToParts(d).map((x) => [x.type, x.value]));
  return { jour: `${p.day}/${p.month}/${p.year}`, heure: `${p.hour}:${p.minute}:${p.second}`, date: new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)) };
};

const csvCellule = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const eurosCsv = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

const nomVentes = (f: Filtres, ext: string) => `transactions_${ymd(f.du)}_${ymd(f.au)}.${ext}`;

// GET /api/export/transactions.csv?<filtres>
exportRouter.get(
  "/transactions.csv",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const f = filtresAutorises(req);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${nomVentes(f, "csv")}"`);
    res.write("﻿");
    res.write(
      ["Date", "Heure", "Lieu", "Ville", "Borne", "Gamme", "Module", "Moyen de paiement", "Statut",
       "Montant TTC", "Montant HT", "Produit", "Tirages", "ID transaction"].join(";") + "\r\n"
    );
    for await (const lot of lotsDeVentes(f)) {
      res.write(
        lot
          .map((l) => {
            const p = enParis(l.horodatage);
            return [p.jour, p.heure, l.enseigne, l.ville, l.identifiant, l.gamme, l.module, l.moyen, l.statut,
                    eurosCsv(l.montant_ttc_cents), eurosCsv(l.montant_ht_cents), l.produit, l.nb_tirages, l.transaction_id_module]
              .map(csvCellule)
              .join(";");
          })
          .join("\r\n") + "\r\n"
      );
    }
    res.end();
  })
);

// GET /api/export/transactions.xlsx?<filtres>
exportRouter.get(
  "/transactions.xlsx",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const f = filtresAutorises(req);
    const colonnes: Colonne<LigneVente>[] = [
      // Date et heure de Paris, en vraie date Excel (sans fuseau)
      { entete: "Date et heure", valeur: (l) => enParis(l.horodatage).date, format: "dateHeure", largeur: 18 },
      { entete: "Lieu", valeur: (l) => l.enseigne, largeur: 28 },
      { entete: "Ville", valeur: (l) => l.ville, largeur: 18 },
      { entete: "Borne", valeur: (l) => l.identifiant },
      { entete: "Gamme", valeur: (l) => l.gamme, largeur: 16 },
      { entete: "Module", valeur: (l) => l.module, largeur: 20 },
      { entete: "Moyen de paiement", valeur: (l) => l.moyen, largeur: 18 },
      { entete: "Statut", valeur: (l) => l.statut },
      { entete: "Montant TTC", valeur: (l) => eurosExcel(l.montant_ttc_cents), format: "euros", largeur: 14 },
      { entete: "Montant HT", valeur: (l) => eurosExcel(l.montant_ht_cents), format: "euros", largeur: 14 },
      { entete: "Produit", valeur: (l) => l.produit, largeur: 20 },
      { entete: "Tirages", valeur: (l) => l.nb_tirages, format: "nombre" },
      { entete: "ID transaction", valeur: (l) => l.transaction_id_module, largeur: 26 },
    ];
    await envoyerClasseur(res, nomVentes(f, "xlsx"), "Ventes", colonnes, lotsDeVentes(f));
  })
);

type LigneClassement = Awaited<ReturnType<typeof classement>>[number] & { rang: number };

const lignesClassement = async (f: Filtres): Promise<LigneClassement[]> =>
  (await classement(f)).map((l, i) => ({ ...l, rang: i + 1 }));
const nomClassement = (f: Filtres, ext: string) => `classement_lieux_${ymd(f.du)}_${ymd(f.au)}.${ext}`;

// GET /api/export/classement.csv?<filtres> — classement des lieux de la vue globale
exportRouter.get(
  "/classement.csv",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const f = filtresAutorises(req);
    const lignes = await lignesClassement(f);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${nomClassement(f, "csv")}"`);
    res.send(
      "﻿" +
        ["Rang", "Lieu", "Ville", "Type", "CA TTC", "Ventes", "Jours avec vente", "CA par jour de vente"].join(";") + "\r\n" +
        lignes
          .map((l) =>
            [l.rang, l.enseigne, l.ville, l.typeLieu, eurosCsv(l.caTtcCents), l.nbVentes, l.joursAvecVente, eurosCsv(l.caParJourVenteCents)]
              .map(csvCellule)
              .join(";")
          )
          .join("\r\n")
    );
  })
);

// GET /api/export/classement.xlsx?<filtres>
exportRouter.get(
  "/classement.xlsx",
  asynchrone<UtilisateurRequest>(async (req, res: Response) => {
    const f = filtresAutorises(req);
    await envoyerClasseur(res, nomClassement(f, "xlsx"), "Classement", [
      { entete: "Rang", valeur: (l: LigneClassement) => l.rang, format: "nombre", largeur: 8 },
      { entete: "Lieu", valeur: (l) => l.enseigne, largeur: 30 },
      { entete: "Ville", valeur: (l) => l.ville, largeur: 18 },
      { entete: "Type", valeur: (l) => l.typeLieu, largeur: 18 },
      { entete: "CA TTC", valeur: (l) => eurosExcel(l.caTtcCents), format: "euros", largeur: 14 },
      { entete: "Ventes", valeur: (l) => l.nbVentes, format: "nombre" },
      { entete: "Jours avec vente", valeur: (l) => l.joursAvecVente, format: "nombre", largeur: 16 },
      { entete: "CA par jour de vente", valeur: (l) => eurosExcel(l.caParJourVenteCents), format: "euros", largeur: 20 },
    ], await lignesClassement(f));
  })
);
