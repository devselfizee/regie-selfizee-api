// Météo à l'emplacement des lieux (CDC V3), de sources gratuites et utilisables commercialement :
// - historique : Météo-France, données climatologiques quotidiennes par station (data.gouv.fr,
//   Licence Ouverte 2.0), station la plus proche du lieu ;
// - prévisions des prochains jours : MET Norway, Locationforecast (api.met.no, CC BY 4.0).
// Les deux sources sont à citer (mention sous les blocs météo de l'application).
import { gunzipSync } from "node:zlib";
import { prisma } from "../lib/prisma.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { localParis } from "../alertes/ouverture.js";

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Au-delà, une station est trop loin pour représenter le lieu. */
export const DISTANCE_STATION_MAX_KM = 40;

export interface MeteoJournaliere {
  jour: string; // AAAA-MM-JJ (Paris)
  tempMax: number | null;
  tempMin: number | null;
  precipitationMm: number | null;
  codeWmo: number | null;
}

// ─── Météo-France : historique par station ───

export interface Station {
  numero: string;
  nom: string;
  latitude: number;
  longitude: number;
  jours: Map<string, { rr: number | null; tx: number | null; tn: number | null }>;
}

const nombre = (s: string | undefined) => (s === undefined || s.trim() === "" ? null : Number(s.replace(",", ".")));

/** Fichier CSV quotidien d'un département (séparateur ;, une ligne par station et par jour). */
export function lireFichierMeteoFrance(csv: string, depuis: string): Station[] {
  const lignes = csv.split(/\r?\n/);
  const entetes = lignes[0].split(";");
  const col = (nom: string) => entetes.indexOf(nom);
  const [iPoste, iNom, iLat, iLon, iDate, iRR, iTX, iTN] = ["NUM_POSTE", "NOM_USUEL", "LAT", "LON", "AAAAMMJJ", "RR", "TX", "TN"].map(col);
  const depuisCompact = depuis.replaceAll("-", "");
  const stations = new Map<string, Station>();
  for (let i = 1; i < lignes.length; i++) {
    const c = lignes[i].split(";");
    if (c.length < entetes.length - 1 || c[iDate] < depuisCompact) continue;
    const rr = nombre(c[iRR]);
    const tx = nombre(c[iTX]);
    if (rr === null && tx === null) continue;
    let s = stations.get(c[iPoste]);
    if (!s) {
      s = { numero: c[iPoste], nom: c[iNom], latitude: Number(c[iLat]), longitude: Number(c[iLon]), jours: new Map() };
      stations.set(s.numero, s);
    }
    const d = c[iDate];
    s.jours.set(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, { rr, tx, tn: nombre(c[iTN]) });
  }
  return [...stations.values()];
}

export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.latitude - a.latitude) / 2) ** 2 + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/**
 * Météo d'un lieu jour par jour : pour chaque mesure, la station la plus proche qui l'a ce jour-là
 * (certaines stations ne mesurent que la pluie). Stations à plus de 40 km ignorées.
 */
export function meteoDuLieu(stations: Station[], position: { latitude: number; longitude: number }): MeteoJournaliere[] {
  const proches = stations
    .map((s) => ({ s, d: distanceKm(position, s) }))
    .filter((x) => x.d <= DISTANCE_STATION_MAX_KM)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.s);
  const jours = new Set(proches.flatMap((s) => [...s.jours.keys()]));
  const premiere = <K extends "rr" | "tx" | "tn">(jour: string, k: K) => {
    for (const s of proches) {
      const v = s.jours.get(jour)?.[k];
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  return [...jours].sort().map((jour) => {
    const pluie = premiere(jour, "rr");
    return { jour, tempMax: premiere(jour, "tx"), tempMin: premiere(jour, "tn"), precipitationMm: pluie, codeWmo: null };
  });
}

/** Département d'après le code postal, tel que nommé dans les fichiers Météo-France (Corse : 20). */
export function departement(codePostal: string | null): string | null {
  const cp = codePostal?.trim();
  if (!cp || !/^\d{5}$/.test(cp)) return null;
  return cp.startsWith("97") || cp.startsWith("98") ? cp.slice(0, 3) : cp.slice(0, 2);
}

const JEU_METEO_FRANCE = "https://www.data.gouv.fr/api/1/datasets/donnees-climatologiques-de-base-quotidiennes/";

/** Adresse du fichier récent (2 dernières années) de chaque département. */
async function fichiersMeteoFrance(): Promise<Map<string, string>> {
  const res = await fetch(JEU_METEO_FRANCE, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`data.gouv.fr : HTTP ${res.status}`);
  const jeu = (await res.json()) as { resources: { url: string }[] };
  const fichiers = new Map<string, string>();
  for (const r of jeu.resources) {
    const m = /\/Q_(\w+?)_latest-\d{4}-\d{4}_RR-T-Vent\.csv\.gz$/.exec(r.url);
    if (m) fichiers.set(m[1], r.url);
  }
  return fichiers;
}

// ─── MET Norway : prévisions ───

const identification = () =>
  `regie-selfizee/1.0 ${process.env.METEO_CONTACT ?? process.env.APP_URL ?? "https://github.com/devselfizee/regie-selfizee-api"}`;

interface PasMetNorway {
  time: string;
  data: {
    instant: { details: { air_temperature?: number } };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
    next_12_hours?: { summary?: { symbol_code?: string } };
  };
}

/** Symbole MET Norway (« lightrain_day »…) → code WMO, pour réutiliser les mêmes libellés. */
export function codeDepuisSymbole(symbole: string | undefined): number | null {
  if (!symbole) return null;
  const s = symbole.replace(/_(day|night|polartwilight)$/, "");
  if (s.includes("thunder")) return 95;
  if (s.includes("snow") || s.includes("sleet")) return 71;
  if (s.includes("heavyrain")) return 65;
  if (s.includes("lightrain")) return 61;
  if (s.includes("rain")) return 63;
  if (s === "fog") return 45;
  if (s === "cloudy") return 3;
  if (s === "partlycloudy") return 2;
  if (s === "fair") return 1;
  if (s === "clearsky") return 0;
  return null;
}

/**
 * Prévision horaire puis par 6 h → journées de Paris : maximum et minimum des températures,
 * somme des pluies de chaque intervalle (1 h ou 6 h selon le pas), temps de la mi-journée.
 */
export function joursDepuisMetNorway(pas: PasMetNorway[]): MeteoJournaliere[] {
  const jours = new Map<string, { t: number[]; pluie: number; symboles: { heure: number; s: string }[] }>();
  pas.forEach((p, i) => {
    const instant = new Date(p.time);
    const { jour, heure } = jourEtHeureLocaux(instant);
    const j = jours.get(ymd(jour)) ?? { t: [], pluie: 0, symboles: [] };
    if (p.data.instant.details.air_temperature !== undefined) j.t.push(p.data.instant.details.air_temperature);
    const suivant = pas[i + 1] ? (new Date(pas[i + 1].time).getTime() - instant.getTime()) / 3_600_000 : null;
    const intervalle = suivant === 1 ? p.data.next_1_hours : suivant === 6 ? p.data.next_6_hours : null;
    j.pluie += intervalle?.details?.precipitation_amount ?? 0;
    const s = p.data.next_6_hours?.summary?.symbol_code ?? p.data.next_1_hours?.summary?.symbol_code ?? p.data.next_12_hours?.summary?.symbol_code;
    if (s) j.symboles.push({ heure, s });
    jours.set(ymd(jour), j);
  });
  return [...jours.entries()].map(([jour, j]) => {
    const midi = [...j.symboles].sort((a, b) => Math.abs(a.heure - 12) - Math.abs(b.heure - 12))[0];
    return {
      jour,
      tempMax: j.t.length ? Math.max(...j.t) : null,
      tempMin: j.t.length ? Math.min(...j.t) : null,
      precipitationMm: Math.round(j.pluie * 10) / 10,
      codeWmo: codeDepuisSymbole(midi?.s),
    };
  });
}

async function previsionsMetNorway(position: { latitude: number; longitude: number }) {
  // 4 décimales au plus : sinon l'API refuse la requête
  const q = new URLSearchParams({ lat: position.latitude.toFixed(4), lon: position.longitude.toFixed(4) });
  const res = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?${q}`, {
    headers: { "User-Agent": identification() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`MET Norway : HTTP ${res.status}`);
  const corps = (await res.json()) as { properties: { timeseries: PasMetNorway[] } };
  return joursDepuisMetNorway(corps.properties.timeseries);
}

// ─── Enregistrement ───

async function enregistrer(lieuId: number, jours: MeteoJournaliere[], prevision: boolean) {
  const utiles = jours.filter((d) => d.tempMax !== null || d.precipitationMm !== null);
  if (!utiles.length) return 0;
  const col = <K extends keyof MeteoJournaliere>(k: K) => utiles.map((d) => d[k]);
  await prisma.$executeRaw`
    INSERT INTO meteo_jour (lieu_id, jour, temp_max, temp_min, precipitation_mm, code_wmo, prevision, maj_le)
    SELECT ${lieuId}, v.jour::date, v.tmax, v.tmin, v.pluie, v.code, ${prevision}, now()
    FROM unnest(${col("jour")}::text[], ${col("tempMax")}::float8[], ${col("tempMin")}::float8[],
                ${col("precipitationMm")}::float8[], ${col("codeWmo")}::int[]) AS v(jour, tmax, tmin, pluie, code)
    ON CONFLICT (lieu_id, jour) DO UPDATE SET temp_max = EXCLUDED.temp_max, temp_min = EXCLUDED.temp_min,
      precipitation_mm = EXCLUDED.precipitation_mm,
      -- l'observation n'a pas de type de temps : on garde celui de la prévision s'il y en avait un
      code_wmo = coalesce(EXCLUDED.code_wmo, meteo_jour.code_wmo),
      prevision = EXCLUDED.prevision, maj_le = now()`;
  return utiles.length;
}

/**
 * Met à jour la météo des lieux géolocalisés : relevés Météo-France depuis l'installation
 * (fichier récent du département, ~2 ans), puis prévisions MET Norway des prochains jours.
 * Les relevés remplacent les prévisions une fois publiés (1 à 2 jours de délai).
 */
export async function synchroniserMeteo(options: { lieuIds?: number[] } = {}) {
  const aujourdhui = jourEtHeureLocaux(new Date()).jour;
  const lieux = await prisma.lieu.findMany({
    where: { latitude: { not: null }, longitude: { not: null }, statut: { in: ["ACTIF", "SUSPENDU"] }, ...(options.lieuIds ? { id: { in: options.lieuIds } } : {}) },
    select: { id: true, latitude: true, longitude: true, codePostal: true, affectations: { select: { debut: true }, orderBy: { debut: "asc" }, take: 1 } },
  });
  let jours = 0;
  const erreurs: string[] = [];
  const position = (l: (typeof lieux)[number]) => ({ latitude: Number(l.latitude), longitude: Number(l.longitude) });

  // Historique : un fichier par département
  const parDepartement = new Map<string, typeof lieux>();
  for (const l of lieux) {
    const d = departement(l.codePostal);
    if (d) parDepartement.set(d, [...(parDepartement.get(d) ?? []), l]);
    else erreurs.push(`lieu ${l.id} : code postal manquant, pas d'historique météo`);
  }
  if (parDepartement.size) {
    try {
      const fichiers = await fichiersMeteoFrance();
      for (const [dep, lieuxDep] of parDepartement) {
        try {
          const url = fichiers.get(dep);
          if (!url) throw new Error(`pas de fichier Météo-France pour le département ${dep}`);
          const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          if (!res.ok) throw new Error(`Météo-France ${dep} : HTTP ${res.status}`);
          const plusAncien = lieuxDep.reduce((m, l) => {
            const debut = l.affectations[0] ? localParis(l.affectations[0].debut).jour : aujourdhui;
            return debut < m ? debut : m;
          }, aujourdhui);
          const stations = lireFichierMeteoFrance(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8"), ymd(plusAncien));
          for (const l of lieuxDep) jours += await enregistrer(l.id, meteoDuLieu(stations, position(l)), false);
        } catch (err) {
          erreurs.push(`département ${dep} : ${(err as Error).message}`);
        }
      }
    } catch (err) {
      erreurs.push(`Météo-France : ${(err as Error).message}`);
    }
  }

  // Prévisions : à partir d'aujourd'hui seulement (le passé vient des relevés)
  for (const l of lieux) {
    try {
      const previsions = (await previsionsMetNorway(position(l))).filter((d) => d.jour >= ymd(aujourdhui));
      jours += await enregistrer(l.id, previsions, true);
    } catch (err) {
      erreurs.push(`lieu ${l.id} : ${(err as Error).message}`);
    }
  }
  return { lieux: lieux.length, jours, erreurs };
}

/** Familles de temps d'après le code WMO, pour l'affichage. */
export function libelleTemps(code: number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  if (code === 0) return "Ensoleillé";
  if (code <= 2) return "Éclaircies";
  if (code === 3) return "Couvert";
  if (code <= 48) return "Brouillard";
  if (code <= 57) return "Bruine";
  if (code <= 67 || (code >= 80 && code <= 82)) return "Pluie";
  if (code <= 77 || code === 85 || code === 86) return "Neige";
  return "Orage";
}
