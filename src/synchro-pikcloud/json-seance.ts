import { TZDate } from "@date-fns/tz";
import { z } from "zod";
import { FUSEAU_METIER } from "../lib/temps.js";

// Lecture du JSON de séance produit par la borne (contrat PikCloud § 4). Son contenu dépend de la
// version du logiciel et des options de l'événement : on ne rend obligatoire que ce qu'on utilise,
// on ignore le reste, et le JSON complet est gardé tel quel dans medias.brut.
// Les paiements (price, payment_status, extra_payments) ne sont pas exploités : le CA vient de l'ingestion des ventes.

export class JsonSeanceIllisible extends Error {}

const schema = z.looseObject({
  photo_uuid: z.string().optional(),
  date_photo: z.string().optional(),
  save_date: z.string().optional(),
  print_date: z.string().optional(),
  count_print: z.number().int().min(0).optional(),
  testMode: z.boolean().optional(),
  type: z.string().optional(),
  name_photo: z.string().optional(),
  filename: z.string().optional(),
});

export interface ChampsSeance {
  photoUuid: string | null;
  datePhoto: Date | null;
  dateSave: Date | null;
  datePrint: Date | null;
  nbTirages: number | null;
  testMode: boolean;
  type: string | null;
  /** Nom du média avec extension donné par la borne (name_photo, sinon filename du JSON) */
  nomFichier: string | null;
  brut: Record<string, unknown>;
}

/** « AAAA-MM-JJ HH:MM:SS » en heure locale de la borne (Europe/Paris) → instant UTC ; null si absent ou mal formé. */
export function dateLocaleBorne(valeur: string | undefined): Date | null {
  if (!valeur) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(valeur.trim());
  if (!m) return null;
  const [a, mo, j, h, mi, s] = m.slice(1).map(Number);
  const d = new TZDate(a, mo - 1, j, h, mi, s, FUSEAU_METIER);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime());
}

/** UUID avec ou sans tirets → forme canonique avec tirets, minuscules ; null si ce n'en est pas un. */
export function uuidCanonique(valeur: string | undefined): string | null {
  if (!valeur) return null;
  const hex = valeur.trim().toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function lireJsonSeance(texte: string): ChampsSeance {
  let objet: unknown;
  try {
    objet = JSON.parse(texte);
  } catch {
    throw new JsonSeanceIllisible("JSON invalide");
  }
  const r = schema.safeParse(objet);
  if (!r.success) {
    throw new JsonSeanceIllisible(r.error.issues.map((i) => `${i.path.join(".") || "racine"} : ${i.message}`).join(" ; "));
  }
  const d = r.data;
  return {
    photoUuid: uuidCanonique(d.photo_uuid),
    datePhoto: dateLocaleBorne(d.date_photo),
    dateSave: dateLocaleBorne(d.save_date),
    datePrint: dateLocaleBorne(d.print_date),
    nbTirages: d.count_print ?? null,
    testMode: d.testMode === true,
    type: d.type ?? null,
    nomFichier: d.name_photo?.trim() || d.filename?.trim() || null,
    brut: d as Record<string, unknown>,
  };
}
