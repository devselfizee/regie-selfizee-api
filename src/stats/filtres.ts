import { Prisma } from "@prisma/client";
import { z } from "zod";
import { jourEtHeureLocaux } from "../lib/temps.js";

// Champs de la fiche lieu utilisables comme filtre (CDC §5 : "n'importe quel champ de la fiche lieu").
// Clé du paramètre d'URL → colonne SQL de `lieux`.
const FILTRES_LIEU_ID = {
  typeLieuId: "type_lieu_id",
  sousTypeId: "sous_type_id",
  standingId: "standing_id",
  zoneGeoId: "zone_geo_id",
  tailleCommuneId: "taille_commune_id",
  emplacementZoneId: "emplacement_zone_id",
  eclairageId: "eclairage_id",
  origineLeadId: "origine_lead_id",
  commercialId: "commercial_id",
} as const;

const FILTRES_LIEU_ENUM = {
  saisonnalite: "saisonnalite",
  interieurExterieur: "interieur_exterieur",
} as const;

const listeIds = z
  .string()
  .regex(/^\d+(,\d+)*$/)
  .transform((s) => s.split(",").map(Number))
  .optional();
const listeCodes = z
  .string()
  .regex(/^[A-Z_]+(,[A-Z_]+)*$/)
  .transform((s) => s.split(","))
  .optional();
const jour = z.iso.date().transform((v) => new Date(`${v}T00:00:00Z`));

const schema = z.object({
  du: jour.optional(),
  au: jour.optional(),
  gammeId: listeIds,
  typeModuleId: listeIds,
  moyenPaiement: listeCodes,
  lieuId: listeIds,
  clienteleId: listeIds,
  capaciteMin: z.coerce.number().int().optional(),
  capaciteMax: z.coerce.number().int().optional(),
  visibiliteMin: z.coerce.number().int().optional(),
  ...Object.fromEntries(Object.keys(FILTRES_LIEU_ID).map((k) => [k, listeIds])),
  ...Object.fromEntries(Object.keys(FILTRES_LIEU_ENUM).map((k) => [k, listeCodes])),
});

export type Filtres = {
  du: Date;
  au: Date;
  gammeId?: number[];
  typeModuleId?: number[];
  moyenPaiement?: string[];
  lieuId?: number[];
  clienteleId?: number[];
  capaciteMin?: number;
  capaciteMax?: number;
  visibiliteMin?: number;
} & Partial<Record<keyof typeof FILTRES_LIEU_ID, number[]>> &
  Partial<Record<keyof typeof FILTRES_LIEU_ENUM, string[]>>;

/** Lit les filtres de la query string. Période par défaut : les 30 derniers jours. */
export function lireFiltres(query: unknown): Filtres {
  const f = schema.parse(query) as Partial<Filtres>;
  const aujourdhui = jourEtHeureLocaux(new Date()).jour;
  const au = f.au ?? aujourdhui;
  const du = f.du ?? new Date(au.getTime() - 29 * 86_400_000);
  return { ...f, du, au } as Filtres;
}

export const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Conditions SQL sur la fiche lieu (alias `l`). */
export function conditionsLieu(f: Filtres): Prisma.Sql[] {
  const c: Prisma.Sql[] = [];
  for (const [cle, colonne] of Object.entries(FILTRES_LIEU_ID)) {
    const ids = f[cle as keyof typeof FILTRES_LIEU_ID];
    if (ids?.length) c.push(Prisma.sql`l.${Prisma.raw(colonne)} IN (${Prisma.join(ids)})`);
  }
  for (const [cle, colonne] of Object.entries(FILTRES_LIEU_ENUM)) {
    const codes = f[cle as keyof typeof FILTRES_LIEU_ENUM];
    if (codes?.length) c.push(Prisma.sql`l.${Prisma.raw(colonne)}::text IN (${Prisma.join(codes)})`);
  }
  if (f.lieuId?.length) c.push(Prisma.sql`l.id IN (${Prisma.join(f.lieuId)})`);
  if (f.clienteleId?.length)
    c.push(Prisma.sql`EXISTS (SELECT 1 FROM lieu_clienteles lc WHERE lc.lieu_id = l.id AND lc.ref_valeur_id IN (${Prisma.join(f.clienteleId)}))`);
  if (f.capaciteMin !== undefined) c.push(Prisma.sql`l.capacite_accueil >= ${f.capaciteMin}`);
  if (f.capaciteMax !== undefined) c.push(Prisma.sql`l.capacite_accueil <= ${f.capaciteMax}`);
  if (f.visibiliteMin !== undefined) c.push(Prisma.sql`l.visibilite >= ${f.visibiliteMin}`);
  return c;
}

/** Conditions SQL sur les ventes (alias `a` = agg_jour ou transactions, `b` = bornes). */
export function conditionsVentes(f: Filtres, colonneJour = "a.jour"): Prisma.Sql[] {
  const c: Prisma.Sql[] = [
    Prisma.sql`${Prisma.raw(colonneJour)} BETWEEN ${ymd(f.du)}::date AND ${ymd(f.au)}::date`,
  ];
  if (f.gammeId?.length) c.push(Prisma.sql`b.gamme_id IN (${Prisma.join(f.gammeId)})`);
  if (f.typeModuleId?.length) c.push(Prisma.sql`a.type_module_id IN (${Prisma.join(f.typeModuleId)})`);
  if (f.moyenPaiement?.length) c.push(Prisma.sql`a.moyen_paiement::text IN (${Prisma.join(f.moyenPaiement)})`);
  return c;
}

export const et = (conditions: Prisma.Sql[]) =>
  conditions.length ? Prisma.join(conditions, " AND ") : Prisma.sql`TRUE`;

/** Période de même durée juste avant, et même période l'année précédente. */
export function periodesComparaison(f: Filtres) {
  const duree = f.au.getTime() - f.du.getTime() + 86_400_000;
  const precedente = { du: new Date(f.du.getTime() - duree), au: new Date(f.du.getTime() - 86_400_000) };
  const unAn = (d: Date) => {
    const r = new Date(d);
    r.setUTCFullYear(r.getUTCFullYear() - 1);
    return r;
  };
  return { precedente, n1: { du: unAn(f.du), au: unAn(f.au) } };
}
