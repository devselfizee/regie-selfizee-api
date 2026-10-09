// Météo à l'emplacement des lieux (CDC V3), via Open-Meteo : historique (archive)
// et 3 derniers mois + 10 jours de prévision (forecast).
// Open-Meteo est gratuit pour un usage non commercial ; pour Selfizee, prendre un
// abonnement et renseigner OPEN_METEO_API_KEY (les adresses « customer- » sont alors utilisées).
import { prisma } from "../lib/prisma.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { localParis } from "../alertes/ouverture.js";

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const HISTORIQUE_MAX_JOURS = 2 * 365;
const JOURS_RECENTS = 92;

const cle = () => process.env.OPEN_METEO_API_KEY?.trim();
const hote = (service: "api" | "archive-api") => `https://${cle() ? "customer-" : ""}${service}.open-meteo.com/v1`;

interface ReponseOpenMeteo {
  daily?: { time: string[]; temperature_2m_max: (number | null)[]; temperature_2m_min: (number | null)[]; precipitation_sum: (number | null)[]; weather_code: (number | null)[] };
}

async function appeler(service: "api" | "archive-api", chemin: string, params: Record<string, string | number>) {
  const q = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
    timezone: "Europe/Paris",
    ...(cle() ? { apikey: cle()! } : {}),
  });
  const res = await fetch(`${hote(service)}/${chemin}?${q}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Open-Meteo ${service} : HTTP ${res.status}`);
  return ((await res.json()) as ReponseOpenMeteo).daily;
}

async function enregistrer(lieuId: number, d: NonNullable<ReponseOpenMeteo["daily"]>, aujourdhui: string) {
  const idx = d.time.map((_, i) => i).filter((i) => d.temperature_2m_max[i] !== null || d.precipitation_sum[i] !== null);
  if (!idx.length) return 0;
  const col = <T>(x: T[]) => idx.map((i) => x[i]);
  await prisma.$executeRaw`
    INSERT INTO meteo_jour (lieu_id, jour, temp_max, temp_min, precipitation_mm, code_wmo, prevision, maj_le)
    SELECT ${lieuId}, v.jour::date, v.tmax, v.tmin, v.pluie, v.code, v.jour::date > ${aujourdhui}::date, now()
    FROM unnest(${col(d.time)}::text[], ${col(d.temperature_2m_max)}::float8[], ${col(d.temperature_2m_min)}::float8[],
                ${col(d.precipitation_sum)}::float8[], ${col(d.weather_code)}::int[]) AS v(jour, tmax, tmin, pluie, code)
    ON CONFLICT (lieu_id, jour) DO UPDATE SET temp_max = EXCLUDED.temp_max, temp_min = EXCLUDED.temp_min,
      precipitation_mm = EXCLUDED.precipitation_mm, code_wmo = EXCLUDED.code_wmo, prevision = EXCLUDED.prevision, maj_le = now()`;
  return idx.length;
}

/**
 * Met à jour la météo des lieux géolocalisés : 3 derniers mois et 10 jours de prévision,
 * plus, la première fois, l'historique depuis l'installation (2 ans au plus).
 */
export async function synchroniserMeteo(options: { lieuIds?: number[] } = {}) {
  const aujourdhui = jourEtHeureLocaux(new Date()).jour;
  const lieux = await prisma.lieu.findMany({
    where: { latitude: { not: null }, longitude: { not: null }, statut: { in: ["ACTIF", "SUSPENDU"] }, ...(options.lieuIds ? { id: { in: options.lieuIds } } : {}) },
    select: {
      id: true, latitude: true, longitude: true,
      affectations: { select: { debut: true }, orderBy: { debut: "asc" }, take: 1 },
      meteo: { select: { jour: true }, orderBy: { jour: "asc" }, take: 1 },
    },
  });
  let jours = 0;
  const erreurs: string[] = [];
  for (const l of lieux) {
    const position = { latitude: Number(l.latitude), longitude: Number(l.longitude) };
    try {
      const recent = await appeler("api", "forecast", { ...position, past_days: JOURS_RECENTS, forecast_days: 10 });
      if (recent) jours += await enregistrer(l.id, recent, ymd(aujourdhui));

      // Historique manquant entre l'installation et les 3 derniers mois (archive : ~5 jours de délai)
      const installe = l.affectations[0] ? localParis(l.affectations[0].debut).jour : null;
      const depuis = new Date(Math.max(installe?.getTime() ?? aujourdhui.getTime(), aujourdhui.getTime() - HISTORIQUE_MAX_JOURS * JOUR));
      const finArchive = new Date(aujourdhui.getTime() - (JOURS_RECENTS - 1) * JOUR);
      const dejaDepuis = l.meteo[0]?.jour;
      if (depuis < finArchive && (!dejaDepuis || dejaDepuis > depuis)) {
        const archive = await appeler("archive-api", "archive", { ...position, start_date: ymd(depuis), end_date: ymd(finArchive) });
        if (archive) jours += await enregistrer(l.id, archive, ymd(aujourdhui));
      }
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
