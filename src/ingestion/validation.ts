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
export function erreursUniquementSurLignes(erreurs: ErrorObject[]): boolean {
  return erreurs.every((e) => /^\/transactions\/\d+(\/|$)/.test(e.instancePath));
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
  gratuite?: "mode_gratuit" | "code_staff" | "degrade" | "reimpression";
  pikcloud_uuid?: string;
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
