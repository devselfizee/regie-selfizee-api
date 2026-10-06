// Moteur de calcul des commissions (CDC §6). Fonctions pures, sans base de données :
// tout est en centimes et en points de base (2000 = 20 %).
import type { BaseCalcul, ModeleCommission, PaliersMode, Periodicite, SeuilCumul, SeuilMode } from "@prisma/client";

export interface RegleContrat {
  modele: ModeleCommission;
  base: BaseCalcul;
  netRemboursements: boolean;
  periodicite: Periodicite;
  tauxBp: number | null;
  seuilCents: number | null;
  seuilMode: SeuilMode | null;
  seuilCumul: SeuilCumul | null;
  forfaitCents: number | null;
  minimumGarantiCents: number | null;
  paliersMode: PaliersMode | null;
  paliers: { depuisCents: number; tauxBp: number }[];
}

export interface VentesPeriode {
  caTtcCents: number;
  caHtCents: number;
  rembourseTtcCents: number;
  rembourseHtCents: number;
}

export interface LigneCalcul {
  libelle: string;
  baseCents?: number;
  tauxBp?: number;
  montantCents: number;
}

export interface ResultatCalcul {
  baseCalculCents: number;
  /** Cumul de la base depuis la date d'effet, avant la période (seuil cumulé) */
  cumulAvantCents: number | null;
  commissionCents: number;
  minimumApplique: boolean;
  lignes: LigneCalcul[];
}

const pct = (bp: number) => `${(bp / 100).toLocaleString("fr-FR")} %`;
const eur = (c: number) => `${(c / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Base de calcul d'une période : CA TTC ou HT, net des remboursements si le contrat le prévoit. */
export function baseDeCalcul(r: Pick<RegleContrat, "base" | "netRemboursements">, v: VentesPeriode): number {
  const ca = r.base === "HT" ? v.caHtCents : v.caTtcCents;
  const rembourse = r.base === "HT" ? v.rembourseHtCents : v.rembourseTtcCents;
  return Math.max(0, ca - (r.netRemboursements ? rembourse : 0));
}

/** Tranches triées ; sous la première borne, le taux est nul. */
const tranches = (r: RegleContrat) => [...r.paliers].sort((a, b) => a.depuisCents - b.depuisCents);

/**
 * Commission variable (hors forfait et minimum) pour une base donnée,
 * avec le détail ligne par ligne. Non arrondie : l'arrondi se fait sur le résultat de la période.
 */
export function partVariable(r: RegleContrat, base: number): { montant: number; lignes: LigneCalcul[] } {
  const taux = r.tauxBp ?? 0;
  switch (r.modele) {
    case "AUCUNE":
      return { montant: 0, lignes: [] };

    case "POURCENTAGE":
    case "FORFAIT":
      if (!taux) return { montant: 0, lignes: [] };
      return {
        montant: (base * taux) / 10000,
        lignes: [{ libelle: `${pct(taux)} du CA`, baseCents: base, tauxBp: taux, montantCents: (base * taux) / 10000 }],
      };

    case "POURCENTAGE_APRES_SEUIL": {
      const seuil = r.seuilCents ?? 0;
      if (r.seuilMode === "DES_ATTEINTE") {
        if (base < seuil) {
          return { montant: 0, lignes: [{ libelle: `Seuil de ${eur(seuil)} non atteint`, baseCents: base, montantCents: 0 }] };
        }
        return {
          montant: (base * taux) / 10000,
          lignes: [{ libelle: `${pct(taux)} de tout le CA (seuil de ${eur(seuil)} atteint)`, baseCents: base, tauxBp: taux, montantCents: (base * taux) / 10000 }],
        };
      }
      const assiette = Math.max(0, base - seuil);
      return {
        montant: (assiette * taux) / 10000,
        lignes: [{ libelle: `${pct(taux)} au-delà de ${eur(seuil)}`, baseCents: assiette, tauxBp: taux, montantCents: (assiette * taux) / 10000 }],
      };
    }

    case "PALIERS": {
      const t = tranches(r);
      if (!t.length) return { montant: 0, lignes: [] };
      if (r.paliersMode === "GLOBAL") {
        const atteint = [...t].reverse().find((p) => base >= p.depuisCents);
        if (!atteint) return { montant: 0, lignes: [{ libelle: `Sous le premier palier (${eur(t[0].depuisCents)})`, baseCents: base, montantCents: 0 }] };
        return {
          montant: (base * atteint.tauxBp) / 10000,
          lignes: [{ libelle: `${pct(atteint.tauxBp)} de tout le CA (palier dès ${eur(atteint.depuisCents)})`, baseCents: base, tauxBp: atteint.tauxBp, montantCents: (base * atteint.tauxBp) / 10000 }],
        };
      }
      // Marginal : chaque tranche à son taux
      const lignes: LigneCalcul[] = [];
      let montant = 0;
      t.forEach((p, i) => {
        const fin = t[i + 1]?.depuisCents ?? Infinity;
        const assiette = Math.max(0, Math.min(base, fin) - p.depuisCents);
        if (assiette <= 0) return;
        const m = (assiette * p.tauxBp) / 10000;
        montant += m;
        lignes.push({
          libelle: `${pct(p.tauxBp)} de ${eur(p.depuisCents)} à ${fin === Infinity ? "plus" : eur(fin)}`,
          baseCents: assiette,
          tauxBp: p.tauxBp,
          montantCents: m,
        });
      });
      return { montant, lignes };
    }
  }
}

/** Le seuil (ou les paliers) se cumule-t-il depuis la date d'effet ? */
export const estCumule = (r: RegleContrat) =>
  r.seuilCumul === "CUMULE" && (r.modele === "POURCENTAGE_APRES_SEUIL" || r.modele === "PALIERS");

/**
 * Commission d'une période.
 * Seuil cumulé : commission = variable(cumul fin) − variable(cumul début), ce qui
 * répartit exactement la commission entre les périodes, sans rien compter deux fois.
 */
export function calculerPeriode(r: RegleContrat, ventes: VentesPeriode, cumulAvantCents = 0): ResultatCalcul {
  const base = baseDeCalcul(r, ventes);
  const lignes: LigneCalcul[] = [];
  let variable: number;

  if (estCumule(r)) {
    const avant = partVariable(r, cumulAvantCents);
    const apres = partVariable(r, cumulAvantCents + base);
    variable = apres.montant - avant.montant;
    lignes.push({ libelle: `Cumul depuis la date d'effet : ${eur(cumulAvantCents)} → ${eur(cumulAvantCents + base)}`, montantCents: 0 });
    lignes.push(...apres.lignes.map((l) => ({ ...l, libelle: `${l.libelle} (sur le cumul)` })));
    if (avant.montant) lignes.push({ libelle: "Déjà compté sur les périodes précédentes", montantCents: -avant.montant });
  } else {
    const p = partVariable(r, base);
    variable = p.montant;
    lignes.push(...p.lignes);
  }

  let commission = variable;
  if (r.modele === "FORFAIT" && r.forfaitCents) {
    commission += r.forfaitCents;
    lignes.push({ libelle: "Forfait de la période", montantCents: r.forfaitCents });
  }

  commission = Math.round(commission);
  let minimumApplique = false;
  if (r.minimumGarantiCents && commission < r.minimumGarantiCents) {
    lignes.push({ libelle: `Minimum garanti (${eur(r.minimumGarantiCents)}) : complément`, montantCents: r.minimumGarantiCents - commission });
    commission = r.minimumGarantiCents;
    minimumApplique = true;
  }

  return {
    baseCalculCents: base,
    cumulAvantCents: estCumule(r) ? cumulAvantCents : null,
    commissionCents: commission,
    minimumApplique,
    lignes: lignes.map((l) => ({ ...l, montantCents: Math.round(l.montantCents) })),
  };
}

/** Description en français d'un contrat (fiche lieu, relevé). */
export function decrireContrat(r: RegleContrat): string {
  const taux = r.tauxBp ?? 0;
  const per = { MOIS: "par mois", TRIMESTRE: "par trimestre", SAISON: "par saison", ANNEE: "par an" }[r.periodicite];
  const base = `CA ${r.base}${r.netRemboursements ? " net des remboursements" : ""}`;
  const cumul = estCumule(r) ? ", seuil cumulé depuis la date d'effet" : "";
  let texte: string;
  switch (r.modele) {
    case "AUCUNE":
      texte = "Aucune commission";
      break;
    case "POURCENTAGE":
      texte = `${pct(taux)} du ${base}, ${per}`;
      break;
    case "POURCENTAGE_APRES_SEUIL":
      texte =
        r.seuilMode === "DES_ATTEINTE"
          ? `${pct(taux)} de tout le ${base} dès que ${eur(r.seuilCents ?? 0)} sont atteints, ${per}${cumul}`
          : `${pct(taux)} du ${base} au-delà de ${eur(r.seuilCents ?? 0)}, ${per}${cumul}`;
      break;
    case "PALIERS":
      texte = `Paliers ${r.paliersMode === "GLOBAL" ? "(taux du palier atteint sur tout le CA)" : "(chaque tranche à son taux)"} : ${tranches(r)
        .map((p) => `${pct(p.tauxBp)} dès ${eur(p.depuisCents)}`)
        .join(", ")} — ${base}, ${per}${cumul}`;
      break;
    case "FORFAIT":
      texte = `Forfait de ${eur(r.forfaitCents ?? 0)} ${per}${taux ? ` + ${pct(taux)} du ${base}` : ""}`;
      break;
  }
  if (r.minimumGarantiCents) texte += ` — minimum garanti ${eur(r.minimumGarantiCents)} ${per}`;
  return texte;
}
