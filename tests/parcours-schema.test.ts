import { describe, expect, it } from "vitest";
import { erreursParLigne, erreursUniquementSurLignes, validerLotParcours } from "../src/ingestion/validation.js";

// Exemple de l'avenant « parcours invité » du 26/10/2026, tel quel
const exemple = () => ({
  parcours_id: "S513-20261022-K7PX2M",
  evenement: "FJT5",
  kit: "nightlife",
  code_seance: "K7PX2M",
  photo_uuid: "0f8c1c2e-5b7a-4c1e-9d2a-3f4b5c6d7e8f",
  debut: "2026-10-22T23:10:00+02:00",
  fin: "2026-10-22T23:11:35+02:00",
  duree_s: 95,
  issue: "validee",
  etapes: {
    cadre: "2026-10-22T23:10:04+02:00",
    prise: "2026-10-22T23:10:06+02:00",
    photo: "2026-10-22T23:10:14+02:00",
    revelation: "2026-10-22T23:10:18+02:00",
    offre: "2026-10-22T23:10:40+02:00",
    paiement: "2026-10-22T23:10:55+02:00",
    paiement_demande: "2026-10-22T23:10:56+02:00",
    impression: "2026-10-22T23:11:20+02:00",
  },
  cadre: "carte-01",
  photos: 1,
  recommencer: 1,
  couleurs_relances: 2,
  retours_offre: 1,
  tirages: 2,
  paiement: { demandes: 2, statut: "accepte", montant_ttc_centimes: 800 },
  upsell: { proposes: 1, acceptes: 1, montant_ttc_centimes: 300 },
});
const lot = (parcours: unknown[]) => ({
  schema_version: "1.0", borne_id: "S513", envoye_le: "2026-10-22T23:12:00+02:00", logiciel_version: "2026.10.26", rattrapage: false, parcours,
});

describe("schéma des parcours invité", () => {
  it("accepte l'exemple de l'avenant et une séance abandonnée sans code", () => {
    const abandon = { parcours_id: "S513-20261022-T234507", evenement: "FJT5", kit: "nightlife", debut: "2026-10-22T23:45:07+02:00", fin: "2026-10-22T23:46:27+02:00", duree_s: 80, issue: "delai", etapes: { cadre: "2026-10-22T23:45:10+02:00" }, photos: 0, tirages: 0 };
    expect(validerLotParcours(lot([exemple(), abandon]))).toBe(true);
  });

  it("accepte un photo_uuid de 32 caractères hexadécimaux sans tirets (format du CDC page souvenir)", () => {
    expect(validerLotParcours(lot([{ ...exemple(), photo_uuid: "0f8c1c2e5b7a4c1e9d2a3f4b5c6d7e8f" }]))).toBe(true);
  });

  it("refuse un champ non prévu, une étape inconnue, une date sans fuseau", () => {
    expect(validerLotParcours(lot([{ ...exemple(), inconnu: 1 }]))).toBe(false);
    expect(validerLotParcours(lot([{ ...exemple(), etapes: { accueil: "2026-10-22T23:10:00+02:00" } }]))).toBe(false);
    expect(validerLotParcours(lot([{ ...exemple(), debut: "2026-10-22T23:10:00" }]))).toBe(false);
  });

  it("une ligne fautive est isolée, le reste du lot passe", () => {
    expect(validerLotParcours(lot([exemple(), { ...exemple(), parcours_id: "S513-20261022-ZZZZZZ", issue: "perdue" }]))).toBe(false);
    const erreurs = validerLotParcours.errors ?? [];
    expect(erreursUniquementSurLignes(erreurs, "parcours")).toBe(true);
    expect([...erreursParLigne(erreurs, "parcours").keys()]).toEqual([1]);
  });
});
