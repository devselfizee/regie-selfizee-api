import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { annulationHorsDelai, deciderCarte, finUid, LIMITE_REFUS_MINUTE, montantMaxCommande, noterRefus, normaliserUid, nuitExploitation, reponseUtilisation, tropDeRefus, verifierRenvoi } from "../src/cartes/cartesLieu.js";
import { validerLotTransactions } from "../src/ingestion/validation.js";

// Cartes sans contact du lieu (Mifare), avenant du 23/11/2026 et sa version 2 (24/11)

const carte = {
  lieuId: 7,
  effet: "DEBITE" as const,
  soldeCents: 2000,
  plafondJourCents: null as number | null,
  plafondJourTirages: null as number | null,
  plafondJourUtilisations: null as number | null,
  expireLe: null as Date | null,
  desactiveLe: null as Date | null,
};
const demande = { lieuBorne: 7, montantCents: 650, nb: 2, dejaJour: { cents: 0, tirages: 0, utilisations: 0 }, maintenant: new Date("2026-11-23T22:15:00Z") };

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
  it("valable jusqu'à la fin de la nuit d'expiration : 6 h le lendemain, heure de Paris", () => {
    const expireLe = new Date("2026-11-23T00:00:00Z");
    expect(deciderCarte({ ...carte, expireLe }, demande).ok).toBe(true);
    // 00 h 30 et 5 h 59 à Paris le 24 : encore la nuit du 23 ; 6 h : expirée
    expect(deciderCarte({ ...carte, expireLe }, { ...demande, maintenant: new Date("2026-11-23T23:30:00Z") }).ok).toBe(true);
    expect(deciderCarte({ ...carte, expireLe }, { ...demande, maintenant: new Date("2026-11-24T04:59:00Z") }).ok).toBe(true);
    expect(deciderCarte({ ...carte, expireLe }, { ...demande, maintenant: new Date("2026-11-24T05:00:00Z") })).toEqual({ ok: false, raison: "EXPIREE" });
  });
  it("la nuit d'exploitation passe minuit et bascule à 6 h", () => {
    expect(nuitExploitation(new Date("2026-11-23T22:15:00Z")).toISOString().slice(0, 10)).toBe("2026-11-23");
    expect(nuitExploitation(new Date("2026-11-24T03:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-23");
    expect(nuitExploitation(new Date("2026-11-24T05:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-24");
  });
  it("plafond en nombre d'utilisations, pour les deux effets", () => {
    const limitee = { ...carte, plafondJourUtilisations: 2 };
    expect(deciderCarte(limitee, { ...demande, dejaJour: { cents: 0, tirages: 0, utilisations: 1 } }).ok).toBe(true);
    expect(deciderCarte(limitee, { ...demande, dejaJour: { cents: 0, tirages: 0, utilisations: 2 } })).toEqual({ ok: false, raison: "PLAFOND" });
    expect(deciderCarte({ ...limitee, effet: "OFFERT" }, { ...demande, dejaJour: { cents: 0, tirages: 0, utilisations: 2 } })).toEqual({ ok: false, raison: "PLAFOND" });
  });
  it("refuse un montant au-dessus des tarifs", () => {
    const grille = { paliers: [{ de: 1, prixCents: 350 }, { de: 2, prixCents: 300 }], plusUnCents: 200 };
    expect(montantMaxCommande([grille], 2)).toBe(700);
    expect(montantMaxCommande([grille, { paliers: [{ de: 1, prixCents: 500 }], plusUnCents: 0 }], 2)).toBe(1000);
    expect(deciderCarte(carte, { ...demande, montantMax: 650 }).ok).toBe(true);
    expect(deciderCarte(carte, { ...demande, montantMax: 649 })).toEqual({ ok: false, raison: "MONTANT" });
  });
  it("applique le plafond du jour : en euros pour un débit, en tirages pour des tirages offerts", () => {
    expect(deciderCarte({ ...carte, plafondJourCents: 1000 }, { ...demande, dejaJour: { cents: 350, tirages: 1, utilisations: 1 } }).ok).toBe(true);
    expect(deciderCarte({ ...carte, plafondJourCents: 1000 }, { ...demande, dejaJour: { cents: 351, tirages: 1, utilisations: 1 } })).toEqual({ ok: false, raison: "PLAFOND" });
    const offerte = { ...carte, effet: "OFFERT" as const, plafondJourTirages: 4 };
    expect(deciderCarte(offerte, { ...demande, dejaJour: { cents: 0, tirages: 2, utilisations: 1 } }).ok).toBe(true);
    expect(deciderCarte(offerte, { ...demande, dejaJour: { cents: 0, tirages: 3, utilisations: 1 } })).toEqual({ ok: false, raison: "PLAFOND" });
  });
});

describe("réponse à la borne", () => {
  const base = { accepte: true, effet: "DEBITE" as const, montantDebiteCents: 650, raison: null, annuleeLe: null };
  it("carte débitée : montant débité, libellé s'il existe, jamais le solde ni l'UID", () => {
    expect(reponseUtilisation(base, "Carte VIP")).toEqual({ ok: true, effet: "debite", montant_debite_centimes: 650, libelle: "Carte VIP" });
  });
  it("tirages offerts : sans montant", () => {
    expect(reponseUtilisation({ ...base, effet: "OFFERT", montantDebiteCents: 0 }, null)).toEqual({ ok: true, effet: "offert" });
  });
  it("refus : raison et message", () => {
    expect(reponseUtilisation({ ...base, accepte: false, effet: null, raison: "SOLDE_INSUFFISANT" }, null)).toEqual({ ok: false, raison: "SOLDE_INSUFFISANT", message: "Solde insuffisant" });
  });
  it("une utilisation annulée n'est jamais rendue acceptée à un renvoi", () => {
    expect(reponseUtilisation({ ...base, annuleeLe: new Date() }, "Carte VIP")).toEqual({ ok: false, raison: "ANNULEE", message: "Utilisation annulée par la borne" });
  });
});

describe("renvois, annulations et limite d'essais", () => {
  const demandee = { uid: "04A1B2C3", montantCents: 650, nb: 2 };
  it("un renvoi doit porter la même carte et la même commande", () => {
    expect(() => verifierRenvoi(demandee, demandee)).not.toThrow();
    expect(() => verifierRenvoi(demandee, { ...demandee, uid: "04A1B2C4" })).toThrow(/autre carte/);
    expect(() => verifierRenvoi(demandee, { ...demandee, montantCents: 700 })).toThrow(/autre carte/);
    // Ligne posée par une annulation arrivée la première : rien à comparer, la réponse sera ANNULEE
    expect(() => verifierRenvoi({ uid: null, montantCents: 0, nb: 0 }, demandee)).not.toThrow();
  });
  it("une annulation n'est plus acceptée après 7 jours", () => {
    const le = new Date("2026-11-23T22:15:00Z");
    expect(annulationHorsDelai(le, new Date("2026-11-30T22:15:00Z"))).toBe(false);
    expect(annulationHorsDelai(le, new Date("2026-11-30T22:16:00Z"))).toBe(true);
  });
  it("429 au-delà de quelques refus par minute et par borne", () => {
    const t = 1_000_000;
    for (let i = 0; i < LIMITE_REFUS_MINUTE; i++) {
      expect(tropDeRefus(9001, t)).toBe(false);
      noterRefus(9001, t);
    }
    expect(tropDeRefus(9001, t + 1000)).toBe(true);
    expect(tropDeRefus(9002, t + 1000)).toBe(false);
    expect(tropDeRefus(9001, t + 61_000)).toBe(false);
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
