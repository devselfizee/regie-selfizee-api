// Calendrier (CDC V3) : jours fériés, zone et vacances scolaires.
import { prisma } from "../lib/prisma.js";
import { localParis } from "../alertes/ouverture.js";
import { geocoder } from "../lib/geocodage.js";

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const utc = (a: number, m: number, j: number) => new Date(Date.UTC(a, m - 1, j));

/** Dimanche de Pâques (algorithme de Meeus, calendrier grégorien). */
export function paques(annee: number): Date {
  const a = annee % 19, b = Math.floor(annee / 100), c = annee % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31);
  const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(annee, mois, jour);
}

/** Jours fériés de France métropolitaine (ymd → libellé). */
export function joursFeries(annee: number): Map<string, string> {
  const p = paques(annee);
  const decale = (j: number) => new Date(p.getTime() + j * JOUR);
  return new Map(
    (
      [
        [utc(annee, 1, 1), "Jour de l'an"],
        [decale(1), "Lundi de Pâques"],
        [utc(annee, 5, 1), "Fête du Travail"],
        [utc(annee, 5, 8), "Victoire 1945"],
        [decale(39), "Ascension"],
        [decale(50), "Lundi de Pentecôte"],
        [utc(annee, 7, 14), "Fête nationale"],
        [utc(annee, 8, 15), "Assomption"],
        [utc(annee, 11, 1), "Toussaint"],
        [utc(annee, 11, 11), "Armistice 1918"],
        [utc(annee, 12, 25), "Noël"],
      ] as [Date, string][]
    ).map(([d, l]) => [ymd(d), l])
  );
}

/** Fériés entre deux dates incluses. */
export function feriesEntre(du: Date, au: Date): Map<string, string> {
  const m = new Map<string, string>();
  for (let a = du.getUTCFullYear(); a <= au.getUTCFullYear(); a++)
    for (const [j, l] of joursFeries(a)) if (j >= ymd(du) && j <= ymd(au)) m.set(j, l);
  return m;
}

// Zones de vacances par département (académies, découpage en vigueur depuis 2016)
const ZONES: Record<"A" | "B" | "C", string> = {
  A: "01 03 07 15 16 17 19 21 23 24 25 26 33 38 39 40 42 43 47 58 63 64 69 70 71 73 74 79 86 87 89 90",
  B: "02 04 05 06 08 10 13 14 18 22 27 28 29 35 36 37 41 44 45 49 50 51 52 53 54 55 56 57 59 60 61 62 67 68 72 76 80 83 84 85 88",
  C: "09 11 12 30 31 32 34 46 48 65 66 75 77 78 81 82 91 92 93 94 95",
};
const ZONE_DEPARTEMENT = new Map(Object.entries(ZONES).flatMap(([z, ds]) => ds.split(" ").map((d) => [d, z])));

export type ZoneScolaire = "A" | "B" | "C" | "CORSE";

/** Zone de vacances scolaires d'après le code postal (métropole). */
export function zoneScolaire(codePostal: string | null | undefined): ZoneScolaire | null {
  const cp = codePostal?.trim();
  if (!cp || !/^\d{5}$/.test(cp)) return null;
  if (cp.startsWith("20")) return "CORSE";
  return (ZONE_DEPARTEMENT.get(cp.slice(0, 2)) as ZoneScolaire | undefined) ?? null;
}

const SOURCE = "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records";
const ZONES_SOURCE: Record<string, ZoneScolaire> = { "Zone A": "A", "Zone B": "B", "Zone C": "C", Corse: "CORSE" };

interface EnregistrementVacances {
  description: string;
  start_date: string;
  end_date: string;
  zones: string;
  population: string;
  annee_scolaire: string;
}

/** Une période du jeu de données → premier et dernier jour de vacances (la date de fin est celle de la reprise). */
export function periodeVacances(r: Pick<EnregistrementVacances, "start_date" | "end_date">) {
  const debut = localParis(new Date(r.start_date)).jour;
  const fin = new Date(localParis(new Date(r.end_date)).jour.getTime() - JOUR);
  return fin >= debut ? { debut, fin } : null;
}

/**
 * Récupère les vacances scolaires des années scolaires autour d'aujourd'hui (open data
 * Éducation nationale). Idempotent ; à lancer une fois par jour.
 */
export async function synchroniserVacances(maintenant = new Date()) {
  const a = maintenant.getUTCFullYear();
  const annees = [a - 3, a - 2, a - 1, a, a + 1].map((x) => `"${x}-${x + 1}"`);
  const where = `annee_scolaire IN (${annees.join(",")}) AND zones IN ("Zone A","Zone B","Zone C","Corse")`;
  const enregistrements: EnregistrementVacances[] = [];
  for (let offset = 0; ; offset += 100) {
    const url = `${SOURCE}?where=${encodeURIComponent(where)}&limit=100&offset=${offset}&select=description,start_date,end_date,zones,population,annee_scolaire`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Calendrier scolaire : HTTP ${res.status}`);
    const page = (await res.json()) as { total_count: number; results: EnregistrementVacances[] };
    enregistrements.push(...page.results);
    if (offset + 100 >= page.total_count || !page.results.length) break;
  }
  // Une ligne par académie : on dédoublonne par zone, libellé et année (population « - » ou « Élèves »)
  const periodes = new Map<string, { zone: ZoneScolaire; libelle: string; anneeScolaire: string; debut: Date; fin: Date }>();
  for (const r of enregistrements) {
    const zone = ZONES_SOURCE[r.zones];
    const p = periodeVacances(r);
    if (!zone || !p || r.population === "Enseignants") continue;
    const libelle = r.description.trim();
    periodes.set(`${zone}|${libelle}|${r.annee_scolaire}`, { zone, libelle, anneeScolaire: r.annee_scolaire, ...p });
  }
  for (const v of periodes.values()) {
    await prisma.vacancesScolaires.upsert({
      where: { zone_libelle_anneeScolaire: { zone: v.zone, libelle: v.libelle, anneeScolaire: v.anneeScolaire } },
      create: v,
      update: { debut: v.debut, fin: v.fin },
    });
  }
  return periodes.size;
}

/** Vacances d'une zone qui touchent la période (ymd → libellé). */
export async function vacancesEntre(zone: ZoneScolaire | null, du: Date, au: Date): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!zone) return m;
  const periodes = await prisma.vacancesScolaires.findMany({ where: { zone, debut: { lte: au }, fin: { gte: du } } });
  for (const p of periodes)
    for (let t = Math.max(p.debut.getTime(), du.getTime()); t <= Math.min(p.fin.getTime(), au.getTime()); t += JOUR) m.set(ymd(new Date(t)), p.libelle);
  return m;
}

/** Fiches sans code postal mais avec une ville : code postal déduit par géocodage (zone scolaire). */
export async function completerCodesPostaux() {
  const lieux = await prisma.lieu.findMany({ where: { codePostal: null, ville: { not: null } }, select: { id: true, adresse: true, ville: true } });
  let completes = 0;
  for (const l of lieux) {
    const p = await geocoder(l);
    if (p?.codePostal) {
      await prisma.lieu.update({ where: { id: l.id }, data: { codePostal: p.codePostal } });
      completes++;
    }
  }
  return completes;
}
