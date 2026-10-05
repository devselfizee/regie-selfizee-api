/** Montant HT en centimes à partir du TTC et d'un taux en points de base (2000 = 20 %). */
export function htDepuisTtc(ttcCents: number, tauxTvaBp: number): number {
  return Math.round((ttcCents * 10000) / (10000 + tauxTvaBp));
}

/** "20" ou 5.5 (pourcentage du JSON) → points de base. */
export function pctVersBp(pct: number): number {
  return Math.round(pct * 100);
}
