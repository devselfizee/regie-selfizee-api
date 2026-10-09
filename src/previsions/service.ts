import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { localParis, type OuvertureLieu } from "../alertes/ouverture.js";
import { baseDeCalcul, calculerPeriode, estCumule } from "../commissions/moteur.js";
import { calculer, regleDe } from "../commissions/service.js";
import { libellePeriode, periodesDuContrat } from "../commissions/periodes.js";
import { dateAtteinte, prevoir, type Prevision } from "./prevision.js";
import { chargerContexte, effets, indicesDesLieux } from "../calendrier/contexte.js";
import { debutsEquipement, historiques } from "../stats/historique.js";

const JOUR = 86_400_000;
/** Historique chargé : 8 semaines de référence, un an plus tôt, et la marge de ±3 jours. */
const HISTORIQUE_JOURS = 365 + 7 * 8 + 7;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export const aujourdhui = () => jourEtHeureLocaux(new Date()).jour;
export const moisDe = (d: Date) => ({
  du: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
  au: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)),
});

const selectOuverture = { codePostal: true, saisonnalite: true, horaires: true, saisons: true, fermetures: true } as const;

/**
 * Prévision pour plusieurs lieux sur la même période (une requête pour tout l'historique),
 * corrigée du calendrier et de la météo prévue d'après les effets mesurés sur 12 mois pour chaque lieu.
 */
export async function prevoirLieux(lieux: ({ id: number; codePostal: string | null } & OuvertureLieu)[], du: Date, au: Date, jour = aujourdhui()) {
  const ids = lieux.map((l) => l.id);
  const hier = new Date(jour.getTime() - JOUR);
  const debutRef = new Date(jour.getTime() - 7 * 8 * JOUR);
  const [hist, debuts, indices, contexte] = await Promise.all([
    historiques(ids, new Date(jour.getTime() - HISTORIQUE_JOURS * JOUR)),
    debutsEquipement(ids),
    indicesDesLieux(lieux, new Date(jour.getTime() - 365 * JOUR), hier, hier),
    chargerContexte(lieux, debutRef < du ? debutRef : du, au),
  ]);
  return new Map(
    lieux.map((l) => [
      l.id,
      prevoir(l, hist.get(l.id) ?? new Map(), debuts.get(l.id) ?? null, du, au, jour, { contexte: contexte(l.id).jour, effets: effets(indices.get(l.id) ?? []) }),
    ])
  );
}

async function chargerLieu(lieuId: number) {
  const lieu = await prisma.lieu.findUnique({ where: { id: lieuId }, select: { id: true, ...selectOuverture } });
  if (!lieu) throw new HttpError(404, "INTROUVABLE");
  return lieu;
}

/** Prévision du mois civil en cours pour un lieu. */
export async function previsionMois(lieuId: number, jour = aujourdhui()) {
  const { du, au } = moisDe(jour);
  return (await prevoirLieux([await chargerLieu(lieuId)], du, au, jour)).get(lieuId)!;
}

/**
 * Période de commission en cours : commission attendue en fin de période et date
 * d'atteinte du seuil ou de chaque palier.
 */
export async function previsionCommission(lieuId: number, jour = aujourdhui()) {
  const c = await prisma.contratCommission.findFirst({
    where: { lieuId, dateEffet: { lte: jour }, OR: [{ dateFin: null }, { dateFin: { gt: jour } }] },
    include: { paliers: true, lieu: { select: { saisons: { select: { debut: true, fin: true } } } } },
  });
  if (!c) return null;
  const p = periodesDuContrat(c, jour, c.lieu.saisons).find((x) => x.debut <= jour && x.fin >= jour);
  if (!p) return null;

  const lieu = await chargerLieu(lieuId);
  const prevision = (await prevoirLieux([lieu], p.debut, p.fin, jour)).get(lieuId)!;
  const { regle, ventes, resultat } = await calculer(c, { debut: p.debut, fin: jour });

  // Part HT et remboursements observés sur la période (sinon 90 derniers jours) : appliqués au CA prévu
  const reference = ventes.caTtcCents > 0 ? ventes : (await calculer(c, { debut: new Date(jour.getTime() - 90 * JOUR), fin: jour })).ventes;
  const ratio = (x: number) => (reference.caTtcCents > 0 ? x / reference.caTtcCents : 0);
  const ventesPrevues = (ttc: number) => ({
    caTtcCents: ttc,
    caHtCents: Math.round(ttc * (ratio(reference.caHtCents) || 1 / 1.2)),
    rembourseTtcCents: Math.round(ttc * ratio(reference.rembourseTtcCents)),
    rembourseHtCents: Math.round(ttc * ratio(reference.rembourseHtCents)),
  });
  const ratioBase = baseDeCalcul(regle, ventesPrevues(1_000_000)) / 1_000_000;
  const avant = resultat.cumulAvantCents ?? 0;
  const commission = (ttc: number) => calculerPeriode(regle, ventesPrevues(ttc), avant).commissionCents;

  // Seuils à franchir : seuil du modèle « % après seuil », ou début de chaque palier
  const seuils: { libelle: string; montantCents: number }[] = [];
  if (regle.modele === "POURCENTAGE_APRES_SEUIL" && regle.seuilCents) seuils.push({ libelle: "Seuil de déclenchement", montantCents: regle.seuilCents });
  for (const pa of [...regle.paliers].sort((a, b) => a.depuisCents - b.depuisCents))
    if (pa.depuisCents > 0) seuils.push({ libelle: `Palier à ${(pa.tauxBp / 100).toLocaleString("fr-FR")} %`, montantCents: pa.depuisCents });

  return {
    periode: { debut: ymd(p.debut), fin: ymd(p.fin), libelle: libellePeriode(p, c.periodicite) },
    base: regle.base,
    seuilCumule: estCumule(regle),
    commissionActuelleCents: resultat.commissionCents,
    commissionPrevueCents: commission(prevision.totalCents),
    commissionBasseCents: commission(prevision.basseCents),
    commissionHauteCents: commission(prevision.hauteCents),
    seuils: seuils.map((s) => ({ ...s, atteinte: dateAtteinte(prevision, avant, s.montantCents, ratioBase) })),
    prevision: resume(prevision),
  };
}

/** Sans le détail jour par jour. */
export const resume = ({ jours: _jours, ...p }: Prevision) => p;
