import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import type { UtilisateurRequest } from "../middleware/utilisateur.js";
import { ymd } from "../stats/filtres.js";
import {
  croiser, fermetureLaPlusTardive, joursEffectifs, mediane, moyenne, ORDRE_CAPACITE, ORDRE_FERMETURE, tranchesCapacite, tranchesFermeture,
} from "../stats/segments.js";
import { classement, filtresAutorises } from "./stats.js";

// Analyse par segment (CDC §5.3) : « quels lieux valent le coup ? »
export const segmentsRouter = Router();

const NON_RENSEIGNE = "Non renseigné";

export const INDICATEURS = ["ca", "caJourOuvert", "caHeureOuverture", "caParPlace", "caParVisiteur"] as const;
type Indicateur = (typeof INDICATEURS)[number];

const refSelect = { select: { libelle: true, ordre: true } } as const;
const chargerLieux = (ids: number[]) =>
  prisma.lieu.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, enseigne: true, ville: true, saisonnalite: true, interieurExterieur: true, visibilite: true,
      capaciteAccueil: true, frequentationJour: true, frequentationSemaine: true,
      typeLieu: refSelect, sousType: refSelect, standing: refSelect, zoneGeo: refSelect, tailleCommune: refSelect,
      emplacementZone: refSelect, eclairage: refSelect, origineLead: refSelect,
      commercial: { select: { nom: true, prenom: true } },
      clienteles: { select: { refValeur: refSelect } },
      horaires: true, saisons: true, fermetures: true,
      affectations: { select: { debut: true, fin: true } },
    },
  });
type LieuSegment = Awaited<ReturnType<typeof chargerLieux>>[number];

const libelleRef = (r: { libelle: string } | null) => r?.libelle ?? NON_RENSEIGNE;

/** Critères de la fiche lieu utilisables pour croiser (CDC §3.1 : chaque champ peut servir de filtre). */
const DIMENSIONS: Record<string, { libelle: string; valeurs: (l: LieuSegment) => string[]; ordre?: string[] }> = {
  typeLieu: { libelle: "Type de lieu", valeurs: (l) => [l.typeLieu.libelle] },
  sousType: { libelle: "Sous-type", valeurs: (l) => [libelleRef(l.sousType)] },
  standing: { libelle: "Standing", valeurs: (l) => [libelleRef(l.standing)] },
  zoneGeo: { libelle: "Zone", valeurs: (l) => [libelleRef(l.zoneGeo)] },
  tailleCommune: { libelle: "Taille de la commune", valeurs: (l) => [libelleRef(l.tailleCommune)] },
  clientele: {
    libelle: "Clientèle",
    valeurs: (l) => (l.clienteles.length ? l.clienteles.map((c) => c.refValeur.libelle) : [NON_RENSEIGNE]),
  },
  emplacementZone: { libelle: "Zone dans le lieu", valeurs: (l) => [libelleRef(l.emplacementZone)] },
  eclairage: { libelle: "Éclairage", valeurs: (l) => [libelleRef(l.eclairage)] },
  interieurExterieur: {
    libelle: "Intérieur / extérieur",
    valeurs: (l) => [({ INTERIEUR: "Intérieur", EXTERIEUR: "Extérieur", MIXTE: "Mixte" } as Record<string, string>)[l.interieurExterieur ?? ""] ?? NON_RENSEIGNE],
    ordre: ["Intérieur", "Extérieur", "Mixte"],
  },
  visibilite: {
    libelle: "Visibilité",
    valeurs: (l) => [l.visibilite ? `${l.visibilite} / 5` : NON_RENSEIGNE],
    ordre: ["1 / 5", "2 / 5", "3 / 5", "4 / 5", "5 / 5"],
  },
  saisonnalite: {
    libelle: "Saisonnalité",
    valeurs: (l) => [l.saisonnalite === "SAISONNIER" ? "Saisonnier" : "Annuel"],
    ordre: ["Annuel", "Saisonnier"],
  },
  heureFermeture: {
    libelle: "Heure de fermeture",
    valeurs: (l) => [tranchesFermeture(fermetureLaPlusTardive(l)) ?? NON_RENSEIGNE],
    ordre: ORDRE_FERMETURE,
  },
  capacite: { libelle: "Capacité d'accueil", valeurs: (l) => [tranchesCapacite(l.capaciteAccueil) ?? NON_RENSEIGNE], ordre: ORDRE_CAPACITE },
  commercial: {
    libelle: "Commercial",
    valeurs: (l) => [l.commercial ? [l.commercial.prenom, l.commercial.nom].filter(Boolean).join(" ") : NON_RENSEIGNE],
  },
  origineLead: { libelle: "Origine du lead", valeurs: (l) => [libelleRef(l.origineLead)] },
};
const CLES = Object.keys(DIMENSIONS) as [string, ...string[]];

/** Ordre d'affichage : celui de la liste administrable, sinon l'ordre défini, sinon alphabétique ; « Non renseigné » à la fin. */
function ordonner(cle: string, valeurs: string[], lieux: LieuSegment[]) {
  const def = DIMENSIONS[cle];
  const ordreRef = new Map<string, number>();
  for (const l of lieux) {
    for (const r of [l.typeLieu, l.sousType, l.standing, l.zoneGeo, l.tailleCommune, l.emplacementZone, l.eclairage, l.origineLead, ...l.clienteles.map((c) => c.refValeur)]) {
      if (r) ordreRef.set(r.libelle, r.ordre);
    }
  }
  const rang = (v: string) =>
    v === NON_RENSEIGNE ? 1e9 : def.ordre ? def.ordre.indexOf(v) + 1 || 1e6 : (ordreRef.get(v) ?? 1e5);
  return [...new Set(valeurs)].sort((a, b) => rang(a) - rang(b) || a.localeCompare(b, "fr"));
}

const statistiques = (valeurs: (number | null)[]) => {
  const v = valeurs.filter((x): x is number => x !== null && Number.isFinite(x));
  return { n: v.length, moyenne: moyenne(v), mediane: mediane(v) };
};

// GET /api/stats/segments?du=&au=&x=typeLieu&y=heureFermeture&<filtres>
segmentsRouter.get(
  "/",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const f = filtresAutorises(req);
    const x = z.enum(CLES).default("typeLieu").parse(req.query.x || undefined);
    const y = req.query.y ? z.enum(CLES).parse(req.query.y) : null;

    const ventes = await classement(f);
    const lieux = await chargerLieux(ventes.map((v) => v.lieuId));
    const parId = new Map(lieux.map((l) => [l.id, l]));

    // Indicateurs normalisés par lieu ; sans jour d'ouverture effectif, le lieu est écarté
    const exclus: string[] = [];
    const indicateurs = ventes.flatMap((v) => {
      const l = parId.get(v.lieuId)!;
      const eff = joursEffectifs(l, l.affectations, f.du, f.au);
      if (!eff.jours) {
        exclus.push(l.enseigne);
        return [];
      }
      const frequentationJour = l.frequentationJour ?? (l.frequentationSemaine ? l.frequentationSemaine / 7 : null);
      const caJourOuvert = v.caTtcCents / eff.jours;
      const valeurs: Record<Indicateur, number | null> = {
        ca: v.caTtcCents,
        caJourOuvert,
        caHeureOuverture: eff.minutes ? v.caTtcCents / (eff.minutes / 60) : null,
        caParPlace: l.capaciteAccueil ? caJourOuvert / l.capaciteAccueil : null,
        caParVisiteur: frequentationJour ? v.caTtcCents / (frequentationJour * eff.jours) : null,
      };
      return [{ lieu: l, valeurs, joursEffectifs: eff.jours, heuresEffectives: Math.round(eff.minutes / 60), nbVentes: v.nbVentes }];
    });

    const stats = (groupe: typeof indicateurs) =>
      Object.fromEntries(INDICATEURS.map((k) => [k, statistiques(groupe.map((i) => i.valeurs[k]))]));

    const cases = croiser(indicateurs, (i) => DIMENSIONS[x].valeurs(i.lieu), y ? (i) => DIMENSIONS[y].valeurs(i.lieu) : null);
    const tous = indicateurs.map((i) => i.lieu);

    res.json({
      periode: { du: ymd(f.du), au: ymd(f.au) },
      dimensions: Object.entries(DIMENSIONS).map(([cle, d]) => ({ cle, libelle: d.libelle })),
      x: { cle: x, libelle: DIMENSIONS[x].libelle, valeurs: ordonner(x, cases.map((c) => c.x), tous) },
      y: y ? { cle: y, libelle: DIMENSIONS[y].libelle, valeurs: ordonner(y, cases.map((c) => c.y), tous) } : null,
      cases: cases.map((c) => ({ x: c.x, y: c.y, lieuIds: c.lieux.map((i) => i.lieu.id), stats: stats(c.lieux) })),
      global: stats(indicateurs),
      lieux: indicateurs.map((i) => ({
        lieuId: i.lieu.id,
        enseigne: i.lieu.enseigne,
        ville: i.lieu.ville,
        typeLieu: i.lieu.typeLieu.libelle,
        joursEffectifs: i.joursEffectifs,
        heuresEffectives: i.heuresEffectives,
        nbVentes: i.nbVentes,
        ...i.valeurs,
        criteres: Object.fromEntries(Object.entries(DIMENSIONS).map(([cle, d]) => [cle, d.valeurs(i.lieu).join(", ")])),
      })),
      exclus,
    });
  })
);
