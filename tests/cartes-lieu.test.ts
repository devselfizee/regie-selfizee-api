import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deciderCarte, finUid, normaliserUid, reponseUtilisation } from "../src/cartes/cartesLieu.js";
import { validerLotTransactions } from "../src/ingestion/validation.js";

// Cartes sans contact du lieu (Mifare), avenant du 23/11/2026

const carte = {
  lieuId: 7,
  effet: "DEBITE" as const,
  soldeCents: 2000,
  plafondJourCents: null as number | null,
  plafondJourTirages: null as number | null,
  expireLe: null as Date | null,
  desactiveLe: null as Date | null,
};
const demande = { lieuBorne: 7, montantCents: 650, nb: 2, dejaJour: { cents: 0, tirages: 0 }, maintenant: new Date("2026-11-23T22:15:00Z") };

describe("UID des cartes", () => {
  it("accepte 4, 7 ou 10 octets en hexadécimal, ramenés en majuscules", () => {
    expect(normaliserUid("04a1b2c3")).toBe("04A1B2C3");
    expect(normaliserUid("04:A1:B2:C3:D4:E5:F6")).toBe("04A1B2C3D4E5F6");
    expect(normaliserUid(" 04A1B2C3D4E5F60718AA ")).toBe("04A1B2C3D4E5F60718AA");
  });
  it("refuse une longueur ou un caractère inattendu", () => {
    expect(normaliserUid("04A1B2")).toBeNull();
    expect(normaliserUid("04A1B2C3D4")).toBeNull();
    expect(normaliserUid("04A1B2CZ")).toBeNull();
  });
  it("n'affiche que la fin de l'UID", () => expect(finUid("04A1B2C3")).toBe("…B2C3"));
});

describe("décision pour une carte présentée", () => {
  it("débite le montant de la commande", () => {
    expect(deciderCarte(carte, demande)).toEqual({ ok: true, effet: "DEBITE", debitCents: 650 });
  });
  it("offre les tirages sans débit", () => {
    expect(deciderCarte({ ...carte, effet: "OFFERT", soldeCents: 0 }, demande)).toEqual({ ok: true, effet: "OFFERT", debitCents: 0 });
  });
  it("refuse sans débit partiel quand le solde ne couvre pas la commande", () => {
    expect(deciderCarte({ ...carte, soldeCents: 649 }, demande)).toEqual({ ok: false, raison: "SOLDE_INSUFFISANT" });
    expect(deciderCarte({ ...carte, soldeCents: 650 }, demande).ok).toBe(true);
  });
  it("refuse une carte inconnue, désactivée, expirée ou d'un autre lieu", () => {
    expect(deciderCarte(null, demande)).toEqual({ ok: false, raison: "INCONNUE" });
    expect(deciderCarte({ ...carte, desactiveLe: new Date() }, demande)).toEqual({ ok: false, raison: "DESACTIVEE" });
    expect(deciderCarte({ ...carte, lieuId: 8 }, demande)).toEqual({ ok: false, raison: "LIEU" });
    // Borne en stock : aucun lieu
    expect(deciderCarte(carte, { ...demande, lieuBorne: null })).toEqual({ ok: false, raison: "LIEU" });
  });
  it("valable jusqu'au jour d'expiration inclus, heure de Paris", () => {
    const expireLe = new Date("2026-11-23T00:00:00Z");
    expect(deciderCarte({ ...carte, expireLe }, demande).ok).toBe(true);
    // 23 h 30 à Paris le 23 : encore valable ; 00 h 30 le 24 : expirée
    expect(deciderCarte({ ...carte, expireLe }, { ...demande, maintenant: new Date("2026-11-23T22:30:00Z") }).ok).toBe(true);
    expect(deciderCarte({ ...carte, expireLe }, { ...demande, maintenant: new Date("2026-11-23T23:30:00Z") })).toEqual({ ok: false, raison: "EXPIREE" });
  });
  it("applique le plafond du jour : en euros pour un débit, en tirages pour des tirages offerts", () => {
    expect(deciderCarte({ ...carte, plafondJourCents: 1000 }, { ...demande, dejaJour: { cents: 350, tirages: 1 } }).ok).toBe(true);
    expect(deciderCarte({ ...carte, plafondJourCents: 1000 }, { ...demande, dejaJour: { cents: 351, tirages: 1 } })).toEqual({ ok: false, raison: "PLAFOND" });
    const offerte = { ...carte, effet: "OFFERT" as const, plafondJourTirages: 4 };
    expect(deciderCarte(offerte, { ...demande, dejaJour: { cents: 0, tirages: 2 } }).ok).toBe(true);
    expect(deciderCarte(offerte, { ...demande, dejaJour: { cents: 0, tirages: 3 } })).toEqual({ ok: false, raison: "PLAFOND" });
  });
});

describe("réponse à la borne", () => {
  const base = { accepte: true, effet: "DEBITE" as const, montantDebiteCents: 650, soldeApresCents: 1350, raison: null, annuleeLe: null };
  it("carte débitée : montant et solde restant, libellé s'il existe", () => {
    expect(reponseUtilisation(base, "Carte VIP")).toEqual({ ok: true, effet: "debite", montant_debite_centimes: 650, solde_restant_centimes: 1350, libelle: "Carte VIP" });
  });
  it("tirages offerts : sans montant", () => {
    expect(reponseUtilisation({ ...base, effet: "OFFERT", montantDebiteCents: 0, soldeApresCents: null }, null)).toEqual({ ok: true, effet: "offert" });
  });
  it("refus : raison et message", () => {
    expect(reponseUtilisation({ ...base, accepte: false, effet: null, raison: "SOLDE_INSUFFISANT" }, null)).toEqual({ ok: false, raison: "SOLDE_INSUFFISANT", message: "Solde insuffisant" });
  });
  it("une utilisation annulée n'est jamais rendue acceptée à un renvoi", () => {
    expect(reponseUtilisation({ ...base, annuleeLe: new Date() }, "Carte VIP")).toEqual({ ok: false, raison: "ANNULEE", message: "Utilisation annulée par la borne" });
  });
});

describe("vente payée par une carte du lieu", () => {
  it("le schéma des ventes accepte carte_utilisation_id", () => {
    const lot = JSON.parse(readFileSync(new URL("../schemas/examples/transactions.ok.json", import.meta.url), "utf8"));
    lot.transactions = [{ ...lot.transactions[0], moyen_paiement: "autre", carte_utilisation_id: "S513-20261123-K9CTDU-231500-C" }];
    expect(validerLotTransactions(lot)).toBe(true);
    lot.transactions[0].carte_utilisation_id = "";
    expect(validerLotTransactions(lot)).toBe(false);
  });
});
