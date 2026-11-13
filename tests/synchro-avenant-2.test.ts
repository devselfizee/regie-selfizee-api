import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { validerTransaction, type TransactionJson } from "../src/ingestion/validation.js";
import { completer, type Candidate } from "../src/ingestion/transactions.js";

// Avenant n° 2 à la synchronisation des ventes (28/10/2026), exemple du § 5
const recue = (): TransactionJson => ({
  transaction_id: "C295-20261006-XRAT7W-3",
  horodatage: "2026-10-06T00:47:30+02:00",
  montant_ttc_centimes: 350,
  devise: "EUR",
  statut: "accepte",
  encaissement: "confirme",
  module: { type: "HEXAPAY" },
  moyen_paiement: "autre",
  produit: { code: "TIRAGE_EXTRA", nb_tirages: 1 },
} as TransactionJson);
const renvoyee = (): TransactionJson => ({
  ...recue(),
  moyen_paiement: "sans_contact",
  reference_monetique: "468123",
  reference_sequence: "000001",
  carte_derniers_chiffres: "9526",
  pikcloud_uuid: "3f4b5c6d7e8f4c1e9d2a0f8c1c2e5b7a",
} as TransactionJson);

const candidate = (t: TransactionJson): Candidate => ({
  index: 0,
  t,
  horodatage: new Date(t.horodatage),
  statut: "ACCEPTEE",
  moyenPaiement: t.moyen_paiement.toUpperCase() as Candidate["moyenPaiement"],
  typeModuleId: 1,
  moduleRapprochable: true,
  tauxTvaBp: 2000,
});
// Ligne telle qu'enregistrée au premier envoi (champs utiles à la comparaison)
const ligne = () =>
  ({
    horodatage: new Date("2026-10-06T00:47:30+02:00"),
    montantTtcCents: 350,
    statut: "ACCEPTEE",
    devise: "EUR",
    typeModuleId: 1,
    produitCode: "TIRAGE_EXTRA",
    moyenPaiement: "AUTRE",
    encaissement: "CONFIRME",
    motif: null,
    referenceMonetique: null,
    referenceSequence: null,
    carteFin: null,
    pikcloudUuid: null,
    moduleId: null,
    produitLibelle: null,
    rapprochement: "NON_RAPPROCHE",
  }) as unknown as Prisma.TransactionGetPayload<object>;

describe("avenant n° 2 : schéma", () => {
  it("accepte carte_derniers_chiffres à 4 chiffres et un pikcloud_uuid de 32 hexadécimaux", () => {
    expect(validerTransaction(renvoyee())).toBe(true);
  });
  it("refuse 5 chiffres, une lettre, ou avec des espèces", () => {
    expect(validerTransaction({ ...renvoyee(), carte_derniers_chiffres: "95260" })).toBe(false);
    expect(validerTransaction({ ...renvoyee(), carte_derniers_chiffres: "95A6" })).toBe(false);
    const especes = { ...renvoyee(), moyen_paiement: "especes" } as Record<string, unknown>;
    delete especes.reference_monetique;
    expect(validerTransaction(especes)).toBe(false);
  });
});

describe("avenant n° 2 : renvoi d'une vente déjà reçue", () => {
  it("complète la ligne avec les champs du renvoi", () => {
    const maj = completer(ligne(), candidate(renvoyee()), null);
    expect(maj).toEqual({
      moyenPaiement: "SANS_CONTACT",
      referenceMonetique: "468123",
      referenceSequence: "000001",
      carteFin: "9526",
      pikcloudUuid: "3f4b5c6d7e8f4c1e9d2a0f8c1c2e5b7a",
    });
  });
  it("simple doublon quand rien de nouveau", () => {
    expect(completer(ligne(), candidate(recue()), null)).toEqual({});
  });
  it("conflit si le montant change : la ligne n'est jamais écrasée", () => {
    expect(completer(ligne(), candidate({ ...renvoyee(), montant_ttc_centimes: 800 }), null)).toBeNull();
  });
  it("un champ absent du renvoi n'efface pas la valeur reçue", () => {
    const l = { ...ligne(), referenceMonetique: "468123" } as Prisma.TransactionGetPayload<object>;
    expect(completer(l, candidate(recue()), null)).toEqual({});
  });
});

describe("avenant ventes n° 4 : code de remise sur la vente (13/11/2026)", () => {
  // Exemple du § 3 : impressions offertes
  const offerte = () =>
    ({
      transaction_id: "S513-20261103-K9CTDU-1",
      horodatage: "2026-11-03T23:41:12+01:00",
      montant_ttc_centimes: 0,
      devise: "EUR",
      statut: "accepte",
      module: { type: "HEXAPAY" },
      moyen_paiement: "aucun",
      gratuite: "mode_gratuit",
      code_remise: "K7PX2",
      code_utilisation_id: "S513-20261103-K9CTDU-234112",
      produit: { code: "TIRAGE", libelle: "2 tirages", nb_tirages: 2 },
    }) as TransactionJson;
  const sur = (t: Partial<TransactionJson>) => ({ ...recue(), produit: { code: "TIRAGE", nb_tirages: 1 }, ...t });

  it("accepte l'exemple du § 3 et un code tapé tel quel", () => {
    expect(validerTransaction(offerte())).toBe(true);
    expect(validerTransaction(sur({ code_remise: "k7p-x2" }))).toBe(true);
    expect(validerTransaction(sur({ code_remise: "K7PX2;" }))).toBe(false);
  });
  it("refuse un code sur un refus ou un paiement supplémentaire, et code_utilisation_id sans code", () => {
    expect(validerTransaction(sur({ statut: "refuse", encaissement: undefined, code_remise: "K7PX2" }))).toBe(false);
    expect(validerTransaction({ ...recue(), code_remise: "K7PX2" })).toBe(false); // TIRAGE_EXTRA
    expect(validerTransaction(sur({ code_utilisation_id: "S513-20261103-K9CTDU-234112" }))).toBe(false);
    expect(validerTransaction(sur({ statut: "offert", encaissement: undefined, code_remise: "K7PX2" }))).toBe(true);
  });
  it("un renvoi avec le code complète la ligne, code normalisé", () => {
    const l = { ...ligne(), produitCode: "TIRAGE" } as Prisma.TransactionGetPayload<object>;
    expect(completer(l, candidate(sur({ code_remise: "k7p x2", code_utilisation_id: "U-1" })), null)).toEqual({ codeRemise: "K7PX2", codeUtilisationId: "U-1" });
  });
});
