// Historique journalier des lieux, partagé par les prévisions et l'analyse calendrier / météo.
import { prisma } from "../lib/prisma.js";
import { localParis } from "../alertes/ouverture.js";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** CA TTC par lieu et par jour depuis `depuis`. */
export async function historiques(lieuIds: number[], depuis: Date) {
  const lignes = await prisma.$queryRaw<{ lieu_id: number; jour: Date; ca: number }[]>`
    SELECT lieu_id, jour, sum(ca_ttc_cents)::float8 ca FROM agg_jour
    WHERE lieu_id = ANY(${lieuIds}::int[]) AND jour >= ${ymd(depuis)}::date
    GROUP BY lieu_id, jour`;
  const parLieu = new Map<number, Map<string, number>>();
  for (const l of lignes) {
    if (!parLieu.has(l.lieu_id)) parLieu.set(l.lieu_id, new Map());
    parLieu.get(l.lieu_id)!.set(ymd(l.jour), Number(l.ca));
  }
  return parLieu;
}

/** Premier jour où chaque lieu avait une borne : avant, l'absence de vente ne veut rien dire. */
export async function debutsEquipement(lieuIds: number[]) {
  const g = await prisma.affectationBorne.groupBy({ by: ["lieuId"], where: { lieuId: { in: lieuIds } }, _min: { debut: true } });
  return new Map(g.map((x) => [x.lieuId, x._min.debut ? localParis(x._min.debut).jour : null]));
}

