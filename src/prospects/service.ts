import { prisma } from "../lib/prisma.js";
import { joursOuverts } from "../alertes/ouverture.js";
import { fermetureLaPlusTardive, joursEffectifs } from "../stats/segments.js";
import { aujourdhui } from "../previsions/service.js";
import { completude, estimer, precision, type Profil, type Reference } from "./score.js";

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Jours d'ouverture équipés minimum pour servir de référence. */
export const JOURS_REFERENCE_MIN = 30;

const select = {
  id: true, enseigne: true, ville: true, statut: true, commercialId: true,
  typeLieuId: true, sousTypeId: true, standingId: true, tailleCommuneId: true, zoneGeoId: true,
  saisonnalite: true, interieurExterieur: true, emplacementZoneId: true, eclairageId: true, concurrencePhoto: true,
  visibilite: true, capaciteAccueil: true, frequentationJour: true, latitude: true, longitude: true,
  clienteles: { select: { refValeurId: true } },
  horaires: true, saisons: true, fermetures: true,
  affectations: { select: { debut: true, fin: true } },
  typeLieu: { select: { libelle: true } },
} as const;

type LieuCharge = Awaited<ReturnType<typeof chargerLieux>>[number];

const chargerLieux = (statut: "ACTIF" | "PROSPECT", ids?: number[]) =>
  prisma.lieu.findMany({ where: { statut, ...(ids ? { id: { in: ids } } : {}) }, select });

/** Rang (0, 1, 2…) des valeurs ordinales du référentiel (standing, taille de commune). */
async function rangs() {
  const valeurs = await prisma.refValeur.findMany({ where: { categorie: { in: ["STANDING", "TAILLE_COMMUNE"] } }, orderBy: [{ ordre: "asc" }, { id: "asc" }] });
  const rang = new Map<number, number>();
  for (const cat of ["STANDING", "TAILLE_COMMUNE"]) valeurs.filter((v) => v.categorie === cat).forEach((v, i) => rang.set(v.id, i));
  return rang;
}

function profil(l: LieuCharge, rang: Map<number, number>): Profil {
  return {
    id: l.id,
    enseigne: l.enseigne,
    typeLieuId: l.typeLieuId,
    sousTypeId: l.sousTypeId,
    standing: l.standingId !== null ? rang.get(l.standingId) ?? null : null,
    tailleCommune: l.tailleCommuneId !== null ? rang.get(l.tailleCommuneId) ?? null : null,
    zoneGeoId: l.zoneGeoId,
    saisonnalite: l.saisonnalite,
    interieurExterieur: l.interieurExterieur,
    emplacementZoneId: l.emplacementZoneId,
    eclairageId: l.eclairageId,
    concurrencePhoto: l.concurrencePhoto,
    visibilite: l.visibilite,
    capaciteAccueil: l.capaciteAccueil,
    frequentationJour: l.frequentationJour,
    clienteles: l.clienteles.map((c) => c.refValeurId),
    fermetureTardive: fermetureLaPlusTardive(l),
    latitude: l.latitude !== null ? Number(l.latitude) : null,
    longitude: l.longitude !== null ? Number(l.longitude) : null,
  };
}

/** Lieux équipés servant de référence : CA par jour ouvert et équipé sur les 12 derniers mois. */
export async function references(jour = aujourdhui()) {
  const au = new Date(jour.getTime() - JOUR);
  const du = new Date(au.getTime() - 364 * JOUR);
  const [lieux, rang, ca] = await Promise.all([
    chargerLieux("ACTIF"),
    rangs(),
    prisma.$queryRaw<{ lieu_id: number; ca: number }[]>`
      SELECT lieu_id, sum(ca_ttc_cents)::float8 ca FROM agg_jour
      WHERE jour BETWEEN ${ymd(du)}::date AND ${ymd(au)}::date GROUP BY lieu_id`,
  ]);
  const caLieu = new Map(ca.map((c) => [c.lieu_id, Number(c.ca)]));
  const refs: (Reference & { lieu: LieuCharge })[] = [];
  for (const l of lieux) {
    const { jours } = joursEffectifs(l, l.affectations, du, au);
    if (jours < JOURS_REFERENCE_MIN) continue;
    refs.push({ ...profil(l, rang), caJourOuvertCents: (caLieu.get(l.id) ?? 0) / jours, joursObserves: jours, lieu: l });
  }
  return { refs, rang };
}

/** Score des prospects (tous, ou ceux donnés). `visible` : lieux que l'utilisateur peut nommer. */
export async function scorerProspects(options: { ids?: number[]; commercialId?: number; visible: (lieu: { id: number; commercialId: number | null }) => boolean }) {
  const jour = aujourdhui();
  const [{ refs, rang }, prospects] = await Promise.all([references(jour), chargerLieux("PROSPECT", options.ids)]);
  const anneeProchaine = new Date(jour.getTime() + 364 * JOUR);
  const prec = precision(refs);
  const resultats = prospects
    .filter((p) => options.commercialId === undefined || p.commercialId === options.commercialId)
    .map((p) => {
      const pr = profil(p, rang);
      const e = estimer(pr, refs);
      // Saisonnier sans saison saisie : impossible de compter les jours d'ouverture
      const jours = p.saisonnalite === "SAISONNIER" && !p.saisons.length ? null : joursOuverts(p, jour, anneeProchaine);
      return {
        id: p.id,
        enseigne: p.enseigne,
        ville: p.ville,
        typeLieu: p.typeLieu.libelle,
        completude: completude(pr),
        joursOuvertsAn: jours,
        caAnnuelCents: e && jours !== null ? Math.round(e.caJourOuvertCents * jours) : null,
        estimation: e && {
          ...e,
          // Lieux hors du périmètre de l'utilisateur : anonymisés
          voisins: e.voisins.map((v) => {
            const l = refs.find((r) => r.id === v.id)!.lieu;
            return options.visible(l) ? v : { ...v, id: null, enseigne: `${l.typeLieu.libelle}${l.ville ? ` · ${l.ville}` : ""}` };
          }),
        },
      };
    })
    .sort((a, b) => (b.estimation?.caJourOuvertCents ?? -1) - (a.estimation?.caJourOuvertCents ?? -1));
  return { references: refs.length, precision: prec, prospects: resultats };
}
