import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";

// ajv-formats est publié en CommonJS : selon la résolution, l'export est en .default
const addFormats = ((formatsPlugin as unknown as { default?: unknown }).default ??
  formatsPlugin) as unknown as (ajv: Ajv2020) => Ajv2020;

const lire = (nom: string) =>
  JSON.parse(readFileSync(new URL(`../../schemas/${nom}`, import.meta.url), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);

const schemaTransactions = lire("transactions.v1.schema.json");
const schemaHeartbeat = lire("heartbeat.v1.schema.json");

export const validerLotTransactions = ajv.compile(schemaTransactions);
export const validerTransaction = ajv.compile({
  $ref: `${schemaTransactions.$id}#/$defs/transaction`,
});
export const validerLotHeartbeats = ajv.compile(schemaHeartbeat);

export function formaterErreurs(erreurs: ErrorObject[] | null | undefined): string {
  return (erreurs ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message}${e.keyword === "additionalProperties" ? ` (${(e.params as { additionalProperty: string }).additionalProperty})` : ""}`)
    .join(" ; ");
}

/**
 * Les erreurs portent-elles uniquement sur des transactions individuelles ?
 * Si oui, on accepte le lot et on rejette seulement les lignes fautives.
 */
export function erreursUniquementSurLignes(erreurs: ErrorObject[], tableau = "transactions"): boolean {
  const ligne = new RegExp(`^/${tableau}/\\d+(/|$)`);
  return erreurs.every((e) => ligne.test(e.instancePath));
}

/** Erreurs du schéma regroupées par ligne du tableau (index → message). */
export function erreursParLigne(erreurs: ErrorObject[], tableau: string): Map<number, string> {
  const ligne = new RegExp(`^/${tableau}/(\\d+)`);
  const parLigne = new Map<number, ErrorObject[]>();
  for (const e of erreurs) {
    const m = ligne.exec(e.instancePath);
    if (m) parLigne.set(Number(m[1]), [...(parLigne.get(Number(m[1])) ?? []), e]);
  }
  return new Map([...parLigne].map(([i, es]) => [i, formaterErreurs(es)]));
}

// Types des payloads (miroir des schémas JSON v1, versions 1.0 et 1.1)
export interface TransactionJson {
  transaction_id: string;
  horodatage: string;
  montant_ttc_centimes: number;
  taux_tva_pct?: number;
  devise: string;
  statut: "accepte" | "refuse" | "annule" | "expire" | "offert" | "rembourse";
  encaissement?: "confirme" | "incertain";
  motif?: "invite" | "banque" | "terminal";
  transaction_origine_id?: string;
  module: { type: string; numero_serie?: string };
  moyen_paiement: "cb" | "sans_contact" | "especes" | "mobile" | "web" | "aucun" | "autre";
  reference_monetique?: string;
  reference_sequence?: string;
  gratuite?: "mode_gratuit" | "code_staff" | "degrade" | "reimpression" | "sans_tirage";
  pikcloud_uuid?: string;
  carte_fin?: string;
  /** Même donnée que carte_fin, nom de l'avenant n° 2 (28/10/2026) */
  carte_derniers_chiffres?: string;
  /** Code de remise utilisé pour la vente (13/11/2026) */
  code_remise?: string;
  produit: { code: string; libelle?: string; nb_tirages: number };
}

export interface LotTransactionsJson {
  schema_version: "1.0" | "1.1";
  borne_id: string;
  envoye_le: string;
  logiciel_version: string;
  rattrapage?: boolean;
  transactions: unknown[];
}

export interface HeartbeatJson {
  horodatage: string;
  logiciel_version: string;
  papier_restant?: number;
  ruban_restant?: number;
  imprimante_ok?: boolean;
  module_paiement_ok?: boolean;
  erreurs?: { code: string; message?: string; composant?: string }[];
}

export interface LotHeartbeatsJson {
  schema_version: "1.0" | "1.1";
  borne_id: string;
  heartbeats: HeartbeatJson[];
}

// ─── Parcours invité (avenant du 26/10/2026) ───
const schemaParcours = lire("parcours.v1.schema.json");
export const validerLotParcours = ajv.compile(schemaParcours);

export type EtapeParcours = "cadre" | "prise" | "photo" | "revelation" | "offre" | "paiement" | "paiement_demande" | "impression";

export interface ParcoursJson {
  parcours_id: string;
  evenement: string;
  kit: "nightlife";
  code_seance?: string;
  photo_uuid?: string;
  debut: string;
  fin: string;
  duree_s: number;
  issue: "validee" | "retour" | "delai" | "appel" | "autre";
  etapes: Partial<Record<EtapeParcours, string>>;
  cadre?: string;
  photos: number;
  recommencer?: number;
  couleurs_relances?: number;
  retours_offre?: number;
  tirages: number;
  paiement?: { demandes: number; statut: "accepte" | "refuse" | "annule" | "expire" | "offert" | "inconnu"; montant_ttc_centimes: number; passages?: PassageTerminalJson[] };
  upsell?: { proposes: number; acceptes: number; montant_ttc_centimes: number; passages?: PassageTerminalJson[] };
  appel?: boolean;
  appel_engagee?: boolean;
  // 1.1 (avenant n° 2 du 10/11/2026)
  rendu?: "couleur" | "noir_blanc" | "surprise";
  offre_fermeture?: "non_merci" | "delai" | "paiement" | "retour" | "autre";
  reconstitue?: boolean;
}

/** 1.1 : un passage au terminal (appui sur « Payer », ou « +1 » pour un pote) */
export interface PassageTerminalJson {
  demande?: string;
  envoi?: string;
  reponse?: string;
  statut: "accepte" | "refuse" | "annule" | "expire" | "inconnu";
  duree_ms?: number;
  renvoi?: boolean;
  enregistrement?: { statut: "fait" | "abandonne" | "inconnu"; le?: string; essais?: number };
}

/** Le parcours sans ses champs 1.1 : ce qu'une version reconstituée doit avoir en commun avec l'original */
export function sansChamps11(p: ParcoursJson): ParcoursJson {
  const { rendu: _r, offre_fermeture: _o, reconstitue: _c, ...reste } = p;
  const sansPassages = <T extends { passages?: unknown }>(b: T) => {
    const { passages: _p, ...r } = b;
    return r;
  };
  return {
    ...reste,
    ...(p.paiement && { paiement: sansPassages(p.paiement) }),
    ...(p.upsell && { upsell: sansPassages(p.upsell) }),
  };
}

export interface LotParcoursJson {
  schema_version: "1.0" | "1.1";
  borne_id: string;
  envoye_le: string;
  logiciel_version: string;
  rattrapage?: boolean;
  parcours: ParcoursJson[];
}
