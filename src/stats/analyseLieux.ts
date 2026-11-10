import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { departement } from "../lib/departement.js";
import { jourOuvert, localParis } from "../alertes/ouverture.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { conditionsLieu, conditionsVentes, et, ymd, type Filtres } from "./filtres.js";

// Analyse du parc (page Lieux, onglet « Analyse ») : classement, matrice volume × valeur, critères qui
// font la différence, départements et lieux à surveiller. Tout est calculé ici, par règles et médianes.

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const JOUR = 86_400_000;

/** Seuils des « lieux à surveiller » (maquette validée avec l'exploitant) */
export const SEUILS = {
  caParJourOuvertCents: 1200,
  joursSansVente: 5,
  baisse4Semaines: -0.3,
  tauxPaye: 0.35,
} as const;

// Fenêtre de calcul des règles « depuis » : 0 € sur N jours, baisse sur 4 semaines, semaines sous le seuil
const RECUL_JOURS = 120;

/** Lieu de test : données de démonstration, ou enseigne contenant le mot « test » */
const estTest = (l: { demo: boolean; enseigne: string }) => l.demo || /\btest\b/i.test(l.enseigne);

export function mediane(valeurs: number[]): number | null {
  if (!valeurs.length) return null;
  const v = [...valeurs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Heure de fermeture la plus tardive de la semaine, en minutes depuis 6 h (une fermeture à 2 h = 20 h après 6 h) */
function fermetureTardive(horaires: { ouverture: Date; fermeture: Date }[]): number | null {
  if (!horaires.length) return null;
  const min = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
  return Math.max(...horaires.map((h) => (min(h.fermeture) - 6 * 60 + 24 * 60) % (24 * 60) || 24 * 60));
}
/** Minutes depuis 6 h → « 2 h », « 23 h 30 » */
const heure = (m: number) => {
  const t = (m + 6 * 60) % (24 * 60);
  return `${Math.floor(t / 60)} h${t % 60 ? ` ${String(t % 60).padStart(2, "0")}` : ""}`;
};

type Ligne = Awaited<ReturnType<typeof lignesLieux>>["lignes"][number];

/** Une ligne par lieu actif du périmètre, avec ses chiffres de la période et ses jours (CA, ouvert et équipé). */
async function lignesLieux(f: Filtres) {
  const aujourdhui = jourEtHeureLocaux(new Date()).jour;
  // Dernier jour complet pour les règles « depuis » : la journée en cours n'est pas finie
  const finRegles = f.au < aujourdhui ? f.au : new Date(aujourdhui.getTime() - JOUR);
  const debutFenetre = new Date(Math.min(f.du.getTime(), finRegles.getTime() - (RECUL_JOURS - 1) * JOUR));

  const ids = (
    await prisma.$queryRaw<{ id: number }[]>`SELECT l.id FROM lieux l WHERE l.statut = 'ACTIF' AND ${et(conditionsLieu(f))}`
  ).map((r) => r.id);
  if (!ids.length) return { lignes: [], finRegles };

  const [lieux, ventes, parcours, affectations] = await Promise.all([
    prisma.lieu.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, enseigne: true, ville: true, codePostal: true, demo: true, saisonnalite: true, capaciteAccueil: true,
        visibilite: true, interieurExterieur: true, horaires: true, saisons: true, fermetures: true,
        typeLieu: { select: { libelle: true } },
        standing: { select: { libelle: true } },
        zoneGeo: { select: { libelle: true } },
        tailleCommune: { select: { libelle: true } },
        emplacementZone: { select: { libelle: true } },
      },
    }),
    // CA par lieu et par jour, sur la période et la fenêtre des règles (agg_jour : sans les cartes de test)
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT a.lieu_id, a.jour, sum(a.ca_ttc_cents) ca, sum(a.nb_acceptees) nb
      FROM agg_jour a JOIN lieux l ON l.id = a.lieu_id JOIN bornes b ON b.id = a.borne_id
      WHERE l.id IN (${Prisma.join(ids)}) AND ${et(conditionsVentes({ ...f, du: debutFenetre }))}
      GROUP BY 1, 2`,
    // Séances (parcours invité) et séances payées sur la période
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT p.lieu_id, count(*) seances, count(*) FILTER (WHERE p.paiement_statut = 'accepte') payees
      FROM parcours p JOIN lieux l ON l.id = p.lieu_id JOIN bornes b ON b.id = p.borne_id
      WHERE l.id IN (${Prisma.join(ids)}) AND p.jour_local BETWEEN ${ymd(f.du)}::date AND ${ymd(f.au)}::date
        ${f.gammeId?.length ? Prisma.sql`AND b.gamme_id IN (${Prisma.join(f.gammeId)})` : Prisma.empty}
      GROUP BY 1`,
    // Bornes installées sur la période ou la fenêtre des règles
    prisma.affectationBorne.findMany({
      where: { lieuId: { in: ids }, debut: { lte: new Date(f.au.getTime() + JOUR) }, OR: [{ fin: null }, { fin: { gte: debutFenetre } }] },
      select: { lieuId: true, debut: true, fin: true },
    }),
  ]);

  const caJour = new Map<number, Map<number, number>>();
  for (const v of ventes) {
    const id = n(v.lieu_id);
    if (!caJour.has(id)) caJour.set(id, new Map());
    caJour.get(id)!.set((v.jour as Date).getTime(), n(v.ca));
  }
  const seances = new Map(parcours.map((p) => [n(p.lieu_id), { seances: n(p.seances), payees: n(p.payees) }]));
  const poses = new Map<number, { debut: number; fin: number }[]>();
  for (const a of affectations) {
    const l = poses.get(a.lieuId) ?? [];
    // En jours locaux : le jour de la pose et celui de la dépose comptent comme équipés
    l.push({ debut: localParis(a.debut).jour.getTime(), fin: a.fin ? localParis(a.fin).jour.getTime() : Infinity });
    poses.set(a.lieuId, l);
  }

  const lignes = lieux.map((l) => {
    const ca = caJour.get(l.id) ?? new Map<number, number>();
    const equipeLe = (t: number) => (poses.get(l.id) ?? []).some((p) => p.debut <= t && t <= p.fin);
    // Jour ouvert : le lieu ouvre et une borne y est, ou une vente a eu lieu (horaires incomplets)
    const ouvertLe = (t: number) => (ca.get(t) ?? 0) > 0 || (equipeLe(t) && jourOuvert(l, new Date(t)));
    const somme = (du: number, au: number) => {
      let c = 0, j = 0;
      for (let t = du; t <= au; t += JOUR) {
        c += ca.get(t) ?? 0;
        if (ouvertLe(t)) j++;
      }
      return { ca: c, jours: j };
    };
    const periode = somme(f.du.getTime(), f.au.getTime());
    const s = seances.get(l.id);
    const equipe = (poses.get(l.id) ?? []).some((p) => p.debut <= f.au.getTime() && p.fin >= f.du.getTime());
    return {
      lieuId: l.id,
      enseigne: l.enseigne,
      ville: l.ville,
      typeLieu: l.typeLieu.libelle,
      departement: departement(l.codePostal),
      saisonnier: l.saisonnalite === "SAISONNIER",
      test: estTest(l),
      equipe,
      caTtcCents: periode.ca,
      joursOuverts: periode.jours,
      caParJourOuvertCents: periode.jours ? Math.round(periode.ca / periode.jours) : null,
      // Sans parcours remontés (borne d'avant l'avenant du 26/10/2026) : séances inconnues
      seances: s ? s.seances : null,
      payees: s ? s.payees : null,
      seancesParJourOuvert: s && periode.jours ? s.seances / periode.jours : null,
      caParSeanceCents: s?.seances ? Math.round(periode.ca / s.seances) : null,
      fermeture: fermetureTardive(l.horaires),
      // Pour les critères et les règles (non renvoyés tels quels)
      attributs: {
        joursSemaine: l.horaires.length ? new Set(l.horaires.map((h) => h.jourSemaine)).size : null,
        capacite: l.capaciteAccueil,
        visibilite: l.visibilite,
        saisonnalite: l.saisonnalite === "SAISONNIER" ? "saisonniers" : "ouverts à l'année",
        emplacement: l.interieurExterieur === "EXTERIEUR" ? "en extérieur" : l.interieurExterieur === "MIXTE" ? "intérieur et extérieur" : l.interieurExterieur === "INTERIEUR" ? "en intérieur" : null,
        standing: l.standing?.libelle ?? null,
        zone: l.zoneGeo?.libelle ?? null,
        tailleCommune: l.tailleCommune?.libelle ?? null,
        emplacementZone: l.emplacementZone?.libelle ?? null,
      },
      somme,
    };
  });
  return { lignes, finRegles };
}

/** Sans vente, un lieu n'est retenu que s'il était ouvert ET équipé d'une borne (retour de Sébastien du 10/11) */
const retenu = (l: Ligne) => l.caTtcCents > 0 || (l.joursOuverts > 0 && l.equipe);

interface Groupe {
  libelle: string;
  nb: number;
  medianeCents: number;
}

/**
 * Critères qui coupent les lieux en deux groupes avec un écart net de CA par jour ouvert (médianes).
 * Critère numérique : meilleur seuil ; critère à modalités : meilleure modalité contre les autres.
 */
function criteres(lieux: Ligne[]) {
  const avecCa = lieux.filter((l) => l.caParJourOuvertCents !== null);
  if (avecCa.length < 4) return [];
  const mini = avecCa.length >= 6 ? 2 : 1;
  const resultat: { critere: string; haut: Groupe; bas: Groupe; rapport: number | null }[] = [];

  const comparer = (critere: string, a: Ligne[], libA: string, b: Ligne[], libB: string) => {
    if (a.length < mini || b.length < mini) return null;
    const ma = mediane(a.map((l) => l.caParJourOuvertCents!))!;
    const mb = mediane(b.map((l) => l.caParJourOuvertCents!))!;
    const [haut, bas] = ma >= mb ? [{ libelle: libA, nb: a.length, medianeCents: Math.round(ma) }, { libelle: libB, nb: b.length, medianeCents: Math.round(mb) }] : [{ libelle: libB, nb: b.length, medianeCents: Math.round(mb) }, { libelle: libA, nb: a.length, medianeCents: Math.round(ma) }];
    return { critere, haut, bas, rapport: bas.medianeCents > 0 ? haut.medianeCents / bas.medianeCents : null };
  };
  const meilleur = (candidats: (ReturnType<typeof comparer>)[]) =>
    candidats.filter((c) => c !== null).sort((x, y) => (y!.rapport ?? Infinity) - (x!.rapport ?? Infinity))[0] ?? null;

  const numeriques: { critere: string; valeur: (l: Ligne) => number | null; libelles: (v: number) => [string, string] }[] = [
    { critere: "Heure de fermeture", valeur: (l) => l.fermeture, libelles: (v) => [`ferment à ${heure(v)} ou avant`, `ferment après ${heure(v)}`] },
    { critere: "Jours d'ouverture", valeur: (l) => l.attributs.joursSemaine, libelles: (v) => [`${v} j / semaine ou moins`, `plus de ${v} j / semaine`] },
    { critere: "Capacité d'accueil", valeur: (l) => l.attributs.capacite, libelles: (v) => [`${v} personnes ou moins`, `plus de ${v} personnes`] },
    { critere: "Visibilité de la borne", valeur: (l) => l.attributs.visibilite, libelles: (v) => [`visibilité ${v}/5 ou moins`, `visibilité au-dessus de ${v}/5`] },
  ];
  for (const c of numeriques) {
    const connus = avecCa.filter((l) => c.valeur(l) !== null);
    const seuils = [...new Set(connus.map((l) => c.valeur(l)!))].sort((a, b) => a - b).slice(0, -1);
    const r = meilleur(seuils.map((s) => {
      const [libBas, libHaut] = c.libelles(s);
      return comparer(c.critere, connus.filter((l) => c.valeur(l)! <= s), libBas, connus.filter((l) => c.valeur(l)! > s), libHaut);
    }));
    if (r) resultat.push(r);
  }

  const modalites: { critere: string; valeur: (l: Ligne) => string | null }[] = [
    { critere: "Saison", valeur: (l) => l.attributs.saisonnalite },
    { critere: "Emplacement", valeur: (l) => l.attributs.emplacement },
    { critere: "Standing", valeur: (l) => l.attributs.standing },
    { critere: "Zone", valeur: (l) => l.attributs.zone },
    { critere: "Taille de la commune", valeur: (l) => l.attributs.tailleCommune },
    { critere: "Place de la borne", valeur: (l) => l.attributs.emplacementZone },
  ];
  for (const c of modalites) {
    const connus = avecCa.filter((l) => c.valeur(l) !== null);
    const valeurs = [...new Set(connus.map((l) => c.valeur(l)!))];
    if (valeurs.length < 2) continue;
    const r = meilleur(valeurs.map((v) => comparer(c.critere, connus.filter((l) => c.valeur(l) === v), v, connus.filter((l) => c.valeur(l) !== v), valeurs.length === 2 ? valeurs.find((x) => x !== v)! : "les autres")));
    if (r) resultat.push(r);
  }

  // Écart net : au moins 1,5 fois plus de CA par jour ouvert d'un côté
  return resultat.filter((r) => r.rapport === null || r.rapport >= 1.5).sort((a, b) => (b.rapport ?? Infinity) - (a.rapport ?? Infinity)).slice(0, 4);
}

/** Lieux à surveiller : règles à seuils, sur la période et sur les 4 dernières semaines complètes */
function surveiller(lieux: Ligne[], finRegles: Date) {
  const fin = finRegles.getTime();
  const resultat = [];
  for (const l of lieux) {
    const raisons: { regle: "SOUS_SEUIL" | "SANS_VENTE" | "BAISSE" | "PAYEES"; libelle: string; depuisJours: number | null }[] = [];

    if (l.caParJourOuvertCents !== null && l.caParJourOuvertCents < SEUILS.caParJourOuvertCents) {
      // Depuis combien de semaines complètes le lieu reste sous le seuil
      let semaines = 0;
      for (let k = 0; k < Math.floor(RECUL_JOURS / 7); k++) {
        const s = l.somme(fin - (7 * k + 6) * JOUR, fin - 7 * k * JOUR);
        if (!s.jours) continue;
        if (s.ca / s.jours >= SEUILS.caParJourOuvertCents) break;
        semaines = k + 1;
      }
      raisons.push({ regle: "SOUS_SEUIL", libelle: `sous ${SEUILS.caParJourOuvertCents / 100} € / jour ouvert`, depuisJours: semaines ? semaines * 7 : null });
    }

    // Jours ouverts d'affilée sans vente, en remontant depuis le dernier jour complet
    let sansVente = 0;
    for (let t = fin, k = 0; k < RECUL_JOURS; t -= JOUR, k++) {
      const s = l.somme(t, t);
      if (s.ca > 0) break;
      if (s.jours) sansVente++;
    }
    if (sansVente >= SEUILS.joursSansVente) raisons.push({ regle: "SANS_VENTE", libelle: `0 € sur ${sansVente} jours ouverts`, depuisJours: sansVente });

    // 4 dernières semaines contre les 4 d'avant, par jour ouvert (une fermeture ne compte pas comme une baisse)
    const recent = l.somme(fin - 27 * JOUR, fin);
    const avant = l.somme(fin - 55 * JOUR, fin - 28 * JOUR);
    const evolution4s = recent.jours && avant.jours && avant.ca ? recent.ca / recent.jours / (avant.ca / avant.jours) - 1 : null;
    if (evolution4s !== null && evolution4s <= SEUILS.baisse4Semaines) {
      raisons.push({ regle: "BAISSE", libelle: `${Math.round(evolution4s * 100)} % sur 4 semaines`.replace("-", "−"), depuisJours: 28 });
    }

    const taux = l.seances ? l.payees! / l.seances : null;
    if (taux !== null && taux < SEUILS.tauxPaye) raisons.push({ regle: "PAYEES", libelle: `${Math.round(taux * 100)} % payées`, depuisJours: null });

    if (raisons.length) {
      resultat.push({
        lieuId: l.lieuId,
        enseigne: l.enseigne,
        typeLieu: l.typeLieu,
        departement: l.departement,
        test: l.test,
        raisons,
        caParJourOuvertCents: l.caParJourOuvertCents,
        evolution4Semaines: evolution4s,
        caParJourOuvertAvantCents: avant.jours ? Math.round(avant.ca / avant.jours) : null,
        fermeture: l.fermeture === null ? null : heure(l.fermeture),
        seances: l.seances,
        payees: l.payees,
      });
    }
  }
  // Les lieux de test à la fin ; sinon du plus grand nombre de règles au plus petit CA par jour ouvert
  return resultat.sort((a, b) => Number(a.test) - Number(b.test) || b.raisons.length - a.raisons.length || (a.caParJourOuvertCents ?? 0) - (b.caParJourOuvertCents ?? 0));
}

export async function analyseLieux(f: Filtres) {
  const { lignes, finRegles } = await lignesLieux(f);
  const retenus = lignes.filter(retenu);
  // Le lieu de test : hors classement et médianes, seulement dans « Lieux à surveiller »
  const parc = retenus.filter((l) => !l.test);
  const caJo = parc.filter((l) => l.caParJourOuvertCents !== null);
  const points = parc.filter((l) => l.seancesParJourOuvert !== null && l.caParSeanceCents !== null);

  // Médiane par type de lieu (CA par jour ouvert), avec l'étendue
  const types = new Map<string, number[]>();
  for (const l of caJo) types.set(l.typeLieu, [...(types.get(l.typeLieu) ?? []), l.caParJourOuvertCents!]);

  // Par département : sommes des lieux retenus, CA par jour ouvert = CA ÷ jours ouverts de ses lieux
  const deps = new Map<string, { nbLieux: number; nbSaisonniers: number; joursOuverts: number; caTtcCents: number; seances: number | null; payees: number | null }>();
  for (const l of parc) {
    const cle = l.departement ?? "";
    const d = deps.get(cle) ?? { nbLieux: 0, nbSaisonniers: 0, joursOuverts: 0, caTtcCents: 0, seances: null, payees: null };
    d.nbLieux++;
    if (l.saisonnier) d.nbSaisonniers++;
    d.joursOuverts += l.joursOuverts;
    d.caTtcCents += l.caTtcCents;
    if (l.seances !== null) {
      d.seances = (d.seances ?? 0) + l.seances;
      d.payees = (d.payees ?? 0) + l.payees!;
    }
    deps.set(cle, d);
  }

  const arrondi = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    periode: { du: ymd(f.du), au: ymd(f.au) },
    // Dernier jour complet pris pour les règles « 0 € sur N jours » et « sur 4 semaines »
    finRegles: ymd(finRegles),
    seuils: SEUILS,
    medianes: {
      caParJourOuvertCents: arrondi(mediane(caJo.map((l) => l.caParJourOuvertCents!))),
      seancesParJourOuvert: mediane(points.map((l) => l.seancesParJourOuvert!)),
      caParSeanceCents: arrondi(mediane(points.map((l) => l.caParSeanceCents!))),
    },
    lieux: parc.map(({ attributs: _a, somme: _s, fermeture, ...l }) => ({ ...l, fermeture: fermeture === null ? null : heure(fermeture) })),
    criteres: criteres(parc),
    parType: [...types]
      .map(([typeLieu, v]) => ({ typeLieu, nb: v.length, medianeCents: Math.round(mediane(v)!), minCents: Math.min(...v), maxCents: Math.max(...v) }))
      .sort((a, b) => b.medianeCents - a.medianeCents),
    departements: [...deps]
      .map(([code, d]) => ({ code: code || null, ...d, caParJourOuvertCents: d.joursOuverts ? Math.round(d.caTtcCents / d.joursOuverts) : null }))
      .sort((a, b) => (b.caParJourOuvertCents ?? -1) - (a.caParJourOuvertCents ?? -1)),
    surveiller: surveiller(retenus, finRegles),
  };
}

export type AnalyseLieux = Awaited<ReturnType<typeof analyseLieux>>;
