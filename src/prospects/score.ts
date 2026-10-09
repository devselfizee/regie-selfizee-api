// Score de potentiel d'un lieu prospecté (CDC V3) : CA par jour d'ouverture estimé
// d'après les lieux équipés qui lui ressemblent le plus (plus proches voisins).
// Explicable : on montre les lieux retenus, leur ressemblance et leurs résultats.

export interface Profil {
  id: number;
  enseigne: string;
  typeLieuId: number;
  sousTypeId: number | null;
  standing: number | null; // rang (ordre du référentiel)
  tailleCommune: number | null; // rang
  zoneGeoId: number | null;
  saisonnalite: string;
  interieurExterieur: string | null;
  emplacementZoneId: number | null;
  eclairageId: number | null;
  concurrencePhoto: boolean | null;
  visibilite: number | null; // 1 à 5
  capaciteAccueil: number | null;
  frequentationJour: number | null;
  clienteles: number[];
  fermetureTardive: number | null; // heure de fermeture la plus tardive (26 = 2 h)
  latitude: number | null;
  longitude: number | null;
}

export interface Reference extends Profil {
  caJourOuvertCents: number;
  joursObserves: number;
}

/** Critères comparés, avec leur poids et leur libellé (pour l'explication). */
export const CRITERES: { cle: string; libelle: string; poids: number; distance: (a: Profil, b: Profil) => number | null }[] = [
  { cle: "type", libelle: "Type de lieu", poids: 4, distance: (a, b) => (a.typeLieuId === b.typeLieuId ? 0 : 1) },
  { cle: "sousType", libelle: "Sous-type", poids: 1, distance: (a, b) => egal(a.sousTypeId, b.sousTypeId) },
  { cle: "standing", libelle: "Standing", poids: 1, distance: (a, b) => ecart(a.standing, b.standing, 3) },
  { cle: "tailleCommune", libelle: "Taille de commune", poids: 1, distance: (a, b) => ecart(a.tailleCommune, b.tailleCommune, 4) },
  { cle: "zone", libelle: "Environnement", poids: 1, distance: (a, b) => egal(a.zoneGeoId, b.zoneGeoId) },
  { cle: "saison", libelle: "Saisonnalité", poids: 1, distance: (a, b) => (a.saisonnalite === b.saisonnalite ? 0 : 1) },
  { cle: "interieur", libelle: "Intérieur / extérieur", poids: 0.5, distance: (a, b) => egal(a.interieurExterieur, b.interieurExterieur) },
  { cle: "emplacement", libelle: "Emplacement", poids: 1, distance: (a, b) => egal(a.emplacementZoneId, b.emplacementZoneId) },
  { cle: "eclairage", libelle: "Éclairage", poids: 0.5, distance: (a, b) => egal(a.eclairageId, b.eclairageId) },
  { cle: "concurrence", libelle: "Concurrence photo", poids: 0.5, distance: (a, b) => egal(a.concurrencePhoto, b.concurrencePhoto) },
  { cle: "visibilite", libelle: "Visibilité", poids: 1.5, distance: (a, b) => ecart(a.visibilite, b.visibilite, 4) },
  { cle: "capacite", libelle: "Capacité d'accueil", poids: 1.5, distance: (a, b) => ecartLog(a.capaciteAccueil, b.capaciteAccueil) },
  { cle: "frequentation", libelle: "Fréquentation par jour", poids: 1.5, distance: (a, b) => ecartLog(a.frequentationJour, b.frequentationJour) },
  { cle: "clientele", libelle: "Clientèle", poids: 1, distance: (a, b) => jaccard(a.clienteles, b.clienteles) },
  { cle: "horaires", libelle: "Heure de fermeture", poids: 1, distance: (a, b) => ecart(a.fermetureTardive, b.fermetureTardive, 8) },
  { cle: "distance", libelle: "Proximité", poids: 0.5, distance: (a, b) => (a.latitude == null || b.latitude == null ? null : Math.min(1, km(a, b) / 200)) },
];

const egal = <T>(a: T | null, b: T | null) => (a == null || b == null ? null : a === b ? 0 : 1);
const ecart = (a: number | null, b: number | null, etendue: number) => (a == null || b == null ? null : Math.min(1, Math.abs(a - b) / etendue));
/** Écart d'ordre de grandeur : ×10 = différence maximale. */
const ecartLog = (a: number | null, b: number | null) => (a == null || b == null || a <= 0 || b <= 0 ? null : Math.min(1, Math.abs(Math.log10(a) - Math.log10(b))));
const jaccard = (a: number[], b: number[]) => {
  if (!a.length || !b.length) return null;
  const inter = a.filter((x) => b.includes(x)).length;
  return 1 - inter / new Set([...a, ...b]).size;
};
function km(a: Profil, b: Profil) {
  const r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.latitude! - a.latitude!);
  const dLon = r(b.longitude! - a.longitude!);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.latitude!)) * Math.cos(r(b.latitude!)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Ressemblance de 0 à 1 sur les critères renseignés des deux côtés. */
export function ressemblance(a: Profil, b: Profil) {
  let poids = 0;
  let distance = 0;
  const communs: string[] = [];
  const differences: string[] = [];
  for (const c of CRITERES) {
    const d = c.distance(a, b);
    if (d === null) continue;
    poids += c.poids;
    distance += c.poids * d;
    if (d === 0) communs.push(c.libelle);
    else if (d >= 0.5) differences.push(c.libelle);
  }
  return { similarite: poids ? 1 - distance / poids : 0, communs, differences };
}

/** Part des critères (pondérée) renseignés sur la fiche : plus elle est complète, plus l'estimation est solide. */
export function completude(p: Profil) {
  let total = 0;
  let renseigne = 0;
  const manquants: string[] = [];
  for (const c of CRITERES) {
    total += c.poids;
    // Un critère est renseigné s'il est comparable avec lui-même
    if (c.distance(p, p) !== null) renseigne += c.poids;
    else manquants.push(c.libelle);
  }
  return { taux: renseigne / total, manquants };
}

export const VOISINS = 5;
export const SIMILARITE_MIN = 0.5;

export interface Estimation {
  caJourOuvertCents: number;
  basseCents: number;
  hauteCents: number;
  /** Rang dans le parc actuel (0 à 100) : part des lieux équipés qui font moins */
  score: number;
  classe: "A" | "B" | "C" | "D";
  confiance: "FORTE" | "MOYENNE" | "FAIBLE";
  similariteMoyenne: number;
  voisins: { id: number; enseigne: string; caJourOuvertCents: number; similarite: number; communs: string[]; differences: string[] }[];
}

const quantile = (x: number[], q: number) => {
  const t = [...x].sort((a, b) => a - b);
  const i = (t.length - 1) * q;
  return t[Math.floor(i)] + (t[Math.ceil(i)] - t[Math.floor(i)]) * (i - Math.floor(i));
};

/**
 * Estimation : moyenne des CA par jour ouvert des plus proches voisins, pondérée par le carré
 * de leur ressemblance ; fourchette = 1er et 3e quartiles pondérés approchés par les voisins.
 */
export function estimer(prospect: Profil, references: Reference[], k = VOISINS): Estimation | null {
  const candidats = references.filter((r) => r.id !== prospect.id);
  if (!candidats.length) return null;
  const classes = candidats.map((r) => ({ r, ...ressemblance(prospect, r) })).sort((a, b) => b.similarite - a.similarite);
  // Seulement des lieux vraiment semblables : au moins 50 %, et pas plus de 30 points sous le meilleur
  const seuil = Math.max(SIMILARITE_MIN, classes[0].similarite - 0.3);
  const proches = classes.filter((v) => v.similarite >= seuil).slice(0, k);
  const voisins = proches.length ? proches : classes.slice(0, 1);
  const poids = voisins.map((v) => Math.max(0.01, v.similarite) ** 2);
  const somme = poids.reduce((s, p) => s + p, 0);
  const estimation = voisins.reduce((s, v, i) => s + v.r.caJourOuvertCents * poids[i], 0) / somme;
  const valeurs = voisins.map((v) => v.r.caJourOuvertCents);
  const parc = candidats.map((r) => r.caJourOuvertCents);
  const score = Math.round((100 * parc.filter((x) => x < estimation).length) / parc.length);
  const similariteMoyenne = voisins.reduce((s, v, i) => s + v.similarite * poids[i], 0) / somme;
  const fiche = completude(prospect).taux;
  return {
    caJourOuvertCents: Math.round(estimation),
    basseCents: Math.round(Math.min(estimation, quantile(valeurs, 0.25))),
    hauteCents: Math.round(Math.max(estimation, quantile(valeurs, 0.75))),
    score,
    classe: score >= 75 ? "A" : score >= 50 ? "B" : score >= 25 ? "C" : "D",
    confiance: similariteMoyenne >= 0.8 && fiche >= 0.6 && voisins.length >= 3 ? "FORTE" : similariteMoyenne >= 0.6 && fiche >= 0.35 ? "MOYENNE" : "FAIBLE",
    similariteMoyenne: Math.round(similariteMoyenne * 100) / 100,
    voisins: voisins.map((v) => ({
      id: v.r.id,
      enseigne: v.r.enseigne,
      caJourOuvertCents: Math.round(v.r.caJourOuvertCents),
      similarite: Math.round(v.similarite * 100) / 100,
      communs: v.communs,
      differences: v.differences,
    })),
  };
}

/**
 * Précision de la méthode sur le parc : chaque lieu équipé est estimé à partir des autres
 * (validation croisée « un contre tous »), écart relatif médian entre estimé et réel.
 */
export function precision(references: Reference[]) {
  if (references.length < 4) return null;
  const ecarts = references
    .filter((r) => r.caJourOuvertCents > 0)
    .map((r) => {
      const e = estimer(r, references);
      return e ? Math.abs(e.caJourOuvertCents - r.caJourOuvertCents) / r.caJourOuvertCents : null;
    })
    .filter((x): x is number => x !== null);
  return ecarts.length ? { ecartMedian: Math.round(quantile(ecarts, 0.5) * 100) / 100, lieux: ecarts.length } : null;
}
