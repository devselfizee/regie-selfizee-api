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
  // Adresses tapées sur la borne (« Recevoir par e-mail ») : un tableau JSON dans une chaîne, parfois un tableau direct
  shareWithOthers: z.union([z.string(), z.array(z.unknown())]).optional(),
  // Achat numérique seul, sans tirage
  digital_only: z.boolean().optional(),
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
  /** Adresses e-mail tapées sur la borne, normalisées (minuscules, sans doublon, invalides écartées) */
  adressesPartage: string[];
  numeriqueSeul: boolean;
  brut: Record<string, unknown>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** shareWithOthers → adresses propres. Chaîne : tableau JSON, à défaut une liste séparée par virgules ou espaces. */
export function adressesPartage(brut: unknown): string[] {
  let liste: unknown = brut;
  if (typeof brut === "string") {
    try {
      liste = JSON.parse(brut);
    } catch {
      liste = brut.split(/[\s,;]+/);
    }
  }
  if (!Array.isArray(liste)) return [];
  const vues = new Set<string>();
  for (const x of liste) {
    if (typeof x !== "string") continue;
    const e = x.trim().toLowerCase();
    if (e.length <= 200 && EMAIL.test(e)) vues.add(e);
  }
  return [...vues];
}

const EMPREINTE = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Vrai pour un UUID canonique : seule forme que les colonnes encore en type uuid (transactions.pikcloud_uuid) acceptent. */
export const estUuid = (v: string | null | undefined): v is string => !!v && UUID.test(v);

/**
 * Identifiant de séance tel que la borne l'écrit dans photo_uuid : un UUID (ramené à sa forme canonique), ou
 * l'empreinte de 64 hexadécimaux du logiciel 2.0, gardée telle quelle en minuscules. C'est la clé du QR imprimé.
 */
export function identifiantSeance(valeur: string | undefined): string | null {
  if (!valeur) return null;
  const v = valeur.trim().toLowerCase();
  return EMPREINTE.test(v) ? v : uuidCanonique(v);
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

/**
 * Heure de prise de vue lue dans le nom de base du fichier (« 2026_11_13_10_48_25_00003 », heure locale de la
 * borne) : disponible dès l'annonce du média, avant le JSON. Le JSON, quand il arrive, la remplace par date_photo.
 */
export function dateDuNomFichier(filename: string): Date | null {
  const m = /^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})(?:_|$)/.exec(filename);
  return m ? dateLocaleBorne(`${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`) : null;
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
    photoUuid: identifiantSeance(d.photo_uuid),
    datePhoto: dateLocaleBorne(d.date_photo),
    dateSave: dateLocaleBorne(d.save_date),
    datePrint: dateLocaleBorne(d.print_date),
    nbTirages: d.count_print ?? null,
    testMode: d.testMode === true,
    type: d.type ?? null,
    nomFichier: d.name_photo?.trim() || d.filename?.trim() || null,
    adressesPartage: adressesPartage(d.shareWithOthers),
    numeriqueSeul: d.digital_only === true,
    brut: d as Record<string, unknown>,
  };
}
