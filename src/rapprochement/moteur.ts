// Appariement des lignes d'un relevé monétique avec les ventes remontées par les bornes.
// Fonction pure : la lecture et l'écriture en base sont dans service.ts.

const MINUTE = 60_000;
/** Écart d'horloge toléré entre la borne et le terminal pour un même montant. */
export const TOLERANCE_MIN = 10;
/** En deçà, même paiement malgré un montant différent : c'est un écart de montant. */
export const TOLERANCE_ECART_MIN = 2;
/** Une référence identique suffit, à un jour près. */
const TOLERANCE_REFERENCE_MIN = 24 * 60;

export interface LigneAApparier {
  id: bigint;
  horodatage: Date;
  montantCents: number; // négatif = remboursement
  reference: string | null;
}

export interface VenteAApparier {
  id: bigint;
  horodatage: Date;
  montantCents: number; // signé : remboursement négatif
  reference: string | null;
}

export interface Appariement {
  ligneId: bigint;
  transactionId: bigint;
  statut: "RAPPROCHE" | "ECART";
}

/**
 * Trois passes, chaque vente ne servant qu'une fois :
 * 1. même référence (n° d'autorisation), à un jour près ;
 * 2. même montant, à 10 min près, la plus proche dans le temps ;
 * 3. montant différent mais à 2 min près : écart de montant.
 * Les lignes restantes sont « encaissées non remontées », les ventes restantes « remontées non encaissées ».
 */
export function apparier(lignes: LigneAApparier[], ventes: VenteAApparier[]): Appariement[] {
  const resultat: Appariement[] = [];
  const lignesLibres = new Set(lignes);
  const ventesLibres = new Set(ventes);
  const ecartMin = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / MINUTE;

  const lier = (l: LigneAApparier, v: VenteAApparier) => {
    resultat.push({ ligneId: l.id, transactionId: v.id, statut: l.montantCents === v.montantCents ? "RAPPROCHE" : "ECART" });
    lignesLibres.delete(l);
    ventesLibres.delete(v);
  };

  const plusProche = (l: LigneAApparier, accepte: (v: VenteAApparier) => boolean, toleranceMin: number) => {
    let meilleure: VenteAApparier | undefined;
    let meilleurEcart = Infinity;
    for (const v of ventesLibres) {
      const e = ecartMin(l.horodatage, v.horodatage);
      if (e <= toleranceMin && e < meilleurEcart && accepte(v)) {
        meilleure = v;
        meilleurEcart = e;
      }
    }
    return meilleure;
  };

  for (const l of [...lignesLibres]) {
    if (!l.reference) continue;
    const v = plusProche(l, (v) => v.reference === l.reference, TOLERANCE_REFERENCE_MIN);
    if (v) lier(l, v);
  }
  for (const l of [...lignesLibres]) {
    const v = plusProche(l, (v) => v.montantCents === l.montantCents, TOLERANCE_MIN);
    if (v) lier(l, v);
  }
  for (const l of [...lignesLibres]) {
    // même sens (vente / remboursement) : un remboursement n'est pas un écart sur une vente
    const v = plusProche(l, (v) => Math.sign(v.montantCents) === Math.sign(l.montantCents), TOLERANCE_ECART_MIN);
    if (v) lier(l, v);
  }
  return resultat;
}
