import { prisma } from "../lib/prisma.js";

// Villes principales de l'application Antennes (Georgie) : source de la liste « Villes principales »
// de la Régie (RefValeur ANTENNE, rattachée aux lieux par lieux.antenne_id).
// GET {ANTENNES_API_URL}/ws/antennes/villes-principales?ws_token={ANTENNES_API_TOKEN} (variables Coolify ;
// ANTENNES_API_URL=https://antennes-api.orkessi.com).
// Code de la valeur : ANT-<id Antennes>, stable quand la ville est renommée.

interface VilleAntennes {
  id: number | string;
  ville_principale?: string | null;
  ville_exacte?: string | null;
  statut?: boolean | number | string | null;
}

const PREFIXE = "ANT-";
const normaliser = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const actif = (s: VilleAntennes["statut"]) => s === undefined || s === null || s === true || s === 1 || s === "1" || s === "true";

export const antennesConfigure = () => Boolean(process.env.ANTENNES_API_URL && process.env.ANTENNES_API_TOKEN);

/** Liste complète des villes principales (toutes, actives ou non) */
export async function lireVillesPrincipales(): Promise<VilleAntennes[]> {
  // Adresse du site, ou adresse complète de la route (avec ou sans ?ws_token=)
  const brute = (process.env.ANTENNES_API_URL ?? "").trim();
  const url = new URL(brute.includes("/villes-principales") ? brute : `${brute.replace(/\/+$/, "")}/ws/antennes/villes-principales`);
  url.searchParams.set("ws_token", process.env.ANTENNES_API_TOKEN ?? "");
  // Liste complète, actives ou non : sans limit, l'API renvoie tout
  url.searchParams.delete("limit");
  url.searchParams.delete("statut");
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  // Le message ne reprend jamais l'adresse : elle contient le jeton
  if (!res.ok) throw new Error(`API Antennes : HTTP ${res.status}`);
  const corps = (await res.json()) as unknown;
  // Liste brute, ou enveloppée ({ data: [...] }, { items: [...] }, { villes_principales: [...] })
  const liste = Array.isArray(corps)
    ? corps
    : (Object.values(corps as Record<string, unknown>).find((v) => Array.isArray(v)) as unknown[] | undefined);
  if (!liste) throw new Error("API Antennes : réponse sans liste de villes principales");
  return (liste as VilleAntennes[]).filter((v) => v && v.id !== undefined && (v.ville_principale ?? v.ville_exacte));
}

export interface ResultatSynchroVilles {
  recues: number;
  creees: number;
  majees: number;
  rapprochees: number;
  desactivees: number;
}

/**
 * Aligne la liste « Villes principales » sur l'application Antennes. Une valeur saisie à la main
 * avec le même nom est rapprochée (ses lieux la gardent) ; une ville qui a disparu est désactivée,
 * jamais supprimée (lieux et statistiques).
 */
export async function synchroniserVillesPrincipales(): Promise<ResultatSynchroVilles> {
  const villes = await lireVillesPrincipales();
  const existantes = await prisma.refValeur.findMany({ where: { categorie: "ANTENNE" } });
  const parCode = new Map(existantes.map((v) => [v.code, v]));
  const manuelles = new Map(existantes.filter((v) => !v.code.startsWith(PREFIXE)).map((v) => [normaliser(v.libelle), v]));
  const r: ResultatSynchroVilles = { recues: villes.length, creees: 0, majees: 0, rapprochees: 0, desactivees: 0 };
  const vus = new Set<string>();

  for (const v of villes) {
    const code = `${PREFIXE}${v.id}`;
    const libelle = String(v.ville_principale ?? v.ville_exacte).trim().slice(0, 200);
    const estActif = actif(v.statut);
    vus.add(code);
    const deja = parCode.get(code);
    if (deja) {
      if (deja.libelle !== libelle || deja.actif !== estActif) {
        await prisma.refValeur.update({ where: { id: deja.id }, data: { libelle, actif: estActif } });
        r.majees++;
      }
      continue;
    }
    const manuelle = manuelles.get(normaliser(libelle));
    if (manuelle) {
      await prisma.refValeur.update({ where: { id: manuelle.id }, data: { code, libelle, actif: estActif } });
      manuelles.delete(normaliser(libelle));
      r.rapprochees++;
      continue;
    }
    await prisma.refValeur.create({ data: { categorie: "ANTENNE", code, libelle, actif: estActif } });
    r.creees++;
  }

  for (const v of existantes) {
    if (v.code.startsWith(PREFIXE) && !vus.has(v.code) && v.actif) {
      await prisma.refValeur.update({ where: { id: v.id }, data: { actif: false } });
      r.desactivees++;
    }
  }
  return r;
}
