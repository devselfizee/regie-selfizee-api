import type { ContratCommission, ContratPalier, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { baseDeCalcul, calculerPeriode, decrireContrat, estCumule, type RegleContrat, type VentesPeriode } from "./moteur.js";
import { libellePeriode, periodesDuContrat, type Periode } from "./periodes.js";

export type ContratAvecPaliers = ContratCommission & { paliers: ContratPalier[] };

/** Statuts figés : un reversement validé n'est plus jamais recalculé (CDC §3.3). */
export const STATUTS_FIGES = ["VALIDE", "FACTURE_PAR_LIEU", "AUTOFACTURE", "PAYE"] as const;

export const regleDe = (c: ContratAvecPaliers): RegleContrat => ({
  modele: c.modele,
  base: c.base,
  netRemboursements: c.netRemboursements,
  periodicite: c.periodicite,
  tauxBp: c.tauxBp,
  seuilCents: c.seuilCents,
  seuilMode: c.seuilMode,
  seuilCumul: c.seuilCumul,
  forfaitCents: c.forfaitCents,
  minimumGarantiCents: c.minimumGarantiCents,
  paliersMode: c.paliersMode,
  paliers: c.paliers.map((p) => ({ depuisCents: p.depuisCents, tauxBp: p.tauxBp })),
});

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const aujourdhui = () => jourEtHeureLocaux(new Date()).jour;
const veille = (d: Date) => new Date(d.getTime() - 86_400_000);

/** Ventes agrégées d'un lieu entre deux jours inclus (heure de Paris). */
export async function ventesDuLieu(lieuId: number, du: Date, au: Date): Promise<VentesPeriode & { nbVentes: number }> {
  const [r] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT coalesce(sum(ca_ttc_cents), 0)::float8 ca_ttc, coalesce(sum(ca_ht_cents), 0)::float8 ca_ht,
           coalesce(sum(rembourse_ttc_cents), 0)::float8 remb_ttc, coalesce(sum(rembourse_ht_cents), 0)::float8 remb_ht,
           coalesce(sum(nb_acceptees), 0)::float8 nb
    FROM agg_jour WHERE lieu_id = ${lieuId} AND jour BETWEEN ${ymd(du)}::date AND ${ymd(au)}::date`;
  return {
    caTtcCents: Number(r.ca_ttc),
    caHtCents: Number(r.ca_ht),
    rembourseTtcCents: Number(r.remb_ttc),
    rembourseHtCents: Number(r.remb_ht),
    nbVentes: Number(r.nb),
  };
}

/** Calcule une période d'un contrat (avec le cumul si le seuil est cumulé). */
export async function calculer(c: ContratAvecPaliers, p: Periode) {
  const regle = regleDe(c);
  const ventes = await ventesDuLieu(c.lieuId, p.debut, p.fin);
  const cumulAvant =
    estCumule(regle) && p.debut > c.dateEffet ? baseDeCalcul(regle, await ventesDuLieu(c.lieuId, c.dateEffet, veille(p.debut))) : 0;
  const resultat = calculerPeriode(regle, ventes, cumulAvant);
  return { regle, ventes, resultat };
}

/**
 * Calcule (ou recalcule) les reversements des périodes terminées.
 * Idempotent : les reversements validés ne sont jamais modifiés ; ceux encore
 * ouverts sont mis à jour (ventes arrivées en retard, avenant…), ajustements conservés.
 */
export async function calculerReversements(options: { lieuId?: number; jusquA?: Date } = {}) {
  const jusquA = options.jusquA ?? veille(aujourdhui());
  const contrats = await prisma.contratCommission.findMany({
    where: options.lieuId ? { lieuId: options.lieuId } : {},
    include: { paliers: true, lieu: { select: { saisons: { select: { debut: true, fin: true } } } } },
    orderBy: [{ lieuId: "asc" }, { dateEffet: "asc" }],
  });

  let calcules = 0;
  let figes = 0;
  const periodesValides = new Map<number, Set<string>>(); // lieuId → débuts de période couverts

  for (const c of contrats) {
    for (const p of periodesDuContrat(c, jusquA, c.lieu.saisons)) {
      if (p.fin > jusquA) continue; // période pas encore terminée
      if (!periodesValides.has(c.lieuId)) periodesValides.set(c.lieuId, new Set());
      periodesValides.get(c.lieuId)!.add(ymd(p.debut));

      const existant = await prisma.reversement.findUnique({ where: { lieuId_periodeDebut: { lieuId: c.lieuId, periodeDebut: p.debut } } });
      if (existant && (STATUTS_FIGES as readonly string[]).includes(existant.statut)) {
        figes++;
        continue;
      }

      const { ventes, resultat } = await calculer(c, p);
      const ajustements = existant?.ajustementsCents ?? 0;
      const donnees = {
        contratId: c.id,
        periodeFin: p.fin,
        statut: "CALCULE" as const,
        caTtcCents: ventes.caTtcCents,
        caHtCents: ventes.caHtCents,
        rembourseCents: c.base === "HT" ? ventes.rembourseHtCents : ventes.rembourseTtcCents,
        baseCalculCents: resultat.baseCalculCents,
        commissionCalculeeCents: resultat.commissionCents,
        montantAReverserCents: resultat.commissionCents + ajustements,
        calculeLe: new Date(),
        detailCalcul: {
          periode: libellePeriode(p, c.periodicite),
          contrat: decrireContrat(regleDe(c)),
          versionContrat: c.version,
          nbVentes: ventes.nbVentes,
          cumulAvantCents: resultat.cumulAvantCents,
          minimumApplique: resultat.minimumApplique,
          lignes: resultat.lignes,
        } as unknown as Prisma.InputJsonValue,
      };
      await prisma.reversement.upsert({
        where: { lieuId_periodeDebut: { lieuId: c.lieuId, periodeDebut: p.debut } },
        create: { lieuId: c.lieuId, periodeDebut: p.debut, ...donnees },
        update: donnees,
      });
      calcules++;
    }
  }

  // Reversements ouverts qui ne correspondent plus à aucune période (avenant, contrat supprimé)
  const ouverts = await prisma.reversement.findMany({
    where: { statut: { in: ["A_CALCULER", "CALCULE"] }, ...(options.lieuId ? { lieuId: options.lieuId } : {}) },
    select: { id: true, lieuId: true, periodeDebut: true },
  });
  const orphelins = ouverts.filter((r) => !periodesValides.get(r.lieuId)?.has(ymd(r.periodeDebut))).map((r) => r.id);
  if (orphelins.length) await prisma.reversement.deleteMany({ where: { id: { in: orphelins } } });

  return { calcules, figes, supprimes: orphelins.length };
}

/** Période en cours du contrat actif : commission estimée à ce jour et position par rapport au seuil. */
export async function commissionEnCours(lieuId: number) {
  const jour = aujourdhui();
  const c = await prisma.contratCommission.findFirst({
    where: { lieuId, dateEffet: { lte: jour }, OR: [{ dateFin: null }, { dateFin: { gt: jour } }] },
    include: { paliers: true, lieu: { select: { saisons: { select: { debut: true, fin: true } } } } },
  });
  if (!c) return null;
  const p = periodesDuContrat(c, jour, c.lieu.saisons).find((x) => x.debut <= jour && x.fin >= jour);
  if (!p) return { contratId: c.id, periode: null, horsSaison: true };

  const { regle, ventes, resultat } = await calculer(c, { debut: p.debut, fin: jour });
  const cumul = estCumule(regle);
  const seuilCents = regle.modele === "POURCENTAGE_APRES_SEUIL" ? regle.seuilCents : null;
  return {
    contratId: c.id,
    periode: { debut: ymd(p.debut), fin: ymd(p.fin), libelle: libellePeriode(p, c.periodicite) },
    caTtcCents: ventes.caTtcCents,
    baseCalculCents: resultat.baseCalculCents,
    commissionEstimeeCents: resultat.commissionCents,
    seuil: seuilCents
      ? {
          seuilCents,
          // Avec un seuil cumulé, on compare le cumul depuis la date d'effet
          atteintCents: resultat.baseCalculCents + (cumul ? resultat.cumulAvantCents ?? 0 : 0),
          cumule: cumul,
        }
      : null,
    minimumGarantiCents: regle.minimumGarantiCents,
  };
}
