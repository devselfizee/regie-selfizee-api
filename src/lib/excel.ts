import ExcelJS from "exceljs";
import type { Response } from "express";

// Exports Excel (.xlsx) : vrais nombres et vraies dates (triables, sommables dans Excel),
// format monétaire, en-tête figé et filtres. Écriture en flux : supporte les gros exports.

export type FormatColonne = "texte" | "euros" | "nombre" | "date" | "dateHeure" | "pourcent";

export interface Colonne<T> {
  entete: string;
  valeur: (ligne: T) => string | number | Date | null | undefined;
  format?: FormatColonne;
  largeur?: number;
}

const FORMATS: Partial<Record<FormatColonne, string>> = {
  euros: '#,##0.00 "€";-#,##0.00 "€"',
  nombre: "#,##0",
  date: "dd/mm/yyyy",
  dateHeure: "dd/mm/yyyy hh:mm",
  pourcent: "0.0 %",
};

/**
 * Envoie un classeur d'une feuille. `lignes` peut être un tableau ou un itérateur
 * asynchrone (lots successifs), pour exporter de gros volumes sans tout charger.
 */
export async function envoyerClasseur<T>(
  res: Response,
  nomFichier: string,
  nomFeuille: string,
  colonnes: Colonne<T>[],
  lignes: T[] | AsyncIterable<T[]>
) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${nomFichier}"`);

  const classeur = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  classeur.creator = "Régie Selfizee";
  const feuille = classeur.addWorksheet(nomFeuille.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
  feuille.columns = colonnes.map((c) => ({
    header: c.entete,
    width: c.largeur ?? Math.max(12, c.entete.length + 2),
    style: FORMATS[c.format ?? "texte"] ? { numFmt: FORMATS[c.format ?? "texte"] } : {},
  }));
  const entete = feuille.getRow(1);
  entete.font = { bold: true };
  entete.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F2EE" } };
  feuille.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colonnes.length } };
  entete.commit();

  const ecrire = (ligne: T) => feuille.addRow(colonnes.map((c) => c.valeur(ligne) ?? null)).commit();
  if (Array.isArray(lignes)) lignes.forEach(ecrire);
  else for await (const lot of lignes) lot.forEach(ecrire);

  feuille.commit();
  await classeur.commit();
}

/** Centimes → euros (nombre), pour une cellule au format monétaire. */
export const euros = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : cents / 100);
