import type { Periodicite } from "@prisma/client";

// Dates "métier" : minuit UTC représentant un jour de calendrier (colonnes @db.Date).
export interface Periode {
  debut: Date;
  fin: Date; // inclus
}

const jour = (a: number, m: number, j: number) => new Date(Date.UTC(a, m, j));
const veille = (d: Date) => new Date(d.getTime() - 86_400_000);

/** Début de la période (mois, trimestre, année civils) qui contient d. */
export function debutDePeriode(d: Date, p: Exclude<Periodicite, "SAISON">): Date {
  const a = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (p === "MOIS") return jour(a, m, 1);
  if (p === "TRIMESTRE") return jour(a, m - (m % 3), 1);
  return jour(a, 0, 1);
}

function suivante(d: Date, p: Exclude<Periodicite, "SAISON">): Date {
  const a = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (p === "MOIS") return jour(a, m + 1, 1);
  if (p === "TRIMESTRE") return jour(a, m + 3, 1);
  return jour(a + 1, 0, 1);
}

/** Une date d'effet doit tomber au début d'une période (un avenant ne coupe pas une période en deux). */
export function estDebutDePeriode(d: Date, p: Periodicite): boolean {
  return p === "SAISON" || debutDePeriode(d, p).getTime() === d.getTime();
}

/**
 * Périodes de calcul d'un contrat, de sa date d'effet jusqu'à `jusquA` inclus
 * (et avant sa date de fin). Pour SAISON, ce sont les saisons du lieu.
 */
export function periodesDuContrat(
  c: { periodicite: Periodicite; dateEffet: Date; dateFin: Date | null },
  jusquA: Date,
  saisons: { debut: Date; fin: Date }[] = []
): Periode[] {
  const finContrat = c.dateFin ? veille(c.dateFin) : null; // dateFin = date d'effet de l'avenant suivant
  const limite = finContrat && finContrat < jusquA ? finContrat : jusquA;

  if (c.periodicite === "SAISON") {
    return saisons
      .filter((s) => s.debut >= c.dateEffet && s.debut <= limite)
      .sort((a, b) => a.debut.getTime() - b.debut.getTime())
      .map((s) => ({ debut: s.debut, fin: finContrat && s.fin > finContrat ? finContrat : s.fin }));
  }

  const res: Periode[] = [];
  for (let d = debutDePeriode(c.dateEffet, c.periodicite); d <= limite && res.length < 1000; d = suivante(d, c.periodicite)) {
    const fin = veille(suivante(d, c.periodicite));
    res.push({ debut: d < c.dateEffet ? c.dateEffet : d, fin: finContrat && fin > finContrat ? finContrat : fin });
  }
  return res;
}

/** Libellé d'une période pour les écrans et relevés. */
export function libellePeriode(p: Periode, periodicite: Periodicite): string {
  const mois = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  const date = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
  if (periodicite === "MOIS") return mois.format(p.debut);
  if (periodicite === "TRIMESTRE") return `T${Math.floor(p.debut.getUTCMonth() / 3) + 1} ${p.debut.getUTCFullYear()}`;
  if (periodicite === "ANNEE") return String(p.debut.getUTCFullYear());
  return `Saison du ${date.format(p.debut)} au ${date.format(p.fin)}`;
}
