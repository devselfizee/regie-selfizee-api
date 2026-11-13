import { describe, expect, it } from "vitest";
import { erreursParLigne, erreursUniquementSurLignes, sansChamps11, validerLotParcours, type ParcoursJson } from "../src/ingestion/validation.js";

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

  // Exemple de l'avenant n° 2 du 10/11/2026 (schéma 1.1), tel quel
  const exemple11 = () => ({
    ...exemple(),
    upsell: undefined,
    rendu: "noir_blanc",
    offre_fermeture: "paiement",
    paiement: {
      demandes: 2, statut: "accepte", montant_ttc_centimes: 350,
      passages: [
        { demande: "2026-11-10T23:10:56+01:00", envoi: "2026-11-10T23:10:56+01:00", reponse: "2026-11-10T23:11:02+01:00", statut: "refuse", duree_ms: 6100 },
        { demande: "2026-11-10T23:11:06+01:00", envoi: "2026-11-10T23:11:06+01:00", reponse: "2026-11-10T23:11:13+01:00", statut: "accepte", duree_ms: 6800, enregistrement: { statut: "fait", le: "2026-11-10T23:11:21+01:00", essais: 1 } },
      ],
    },
  });
  const lot11 = (parcours: unknown[]) => JSON.parse(JSON.stringify({ ...lot(parcours), schema_version: "1.1" }));

  it("1.1 : accepte l'exemple de l'avenant n° 2, un « +1 » et un parcours reconstitué incomplet", () => {
    expect(validerLotParcours(lot11([exemple11()]))).toBe(true);
    const upsell = { proposes: 1, acceptes: 1, montant_ttc_centimes: 300, passages: [{ demande: "2026-11-10T23:11:30+01:00", reponse: "2026-11-10T23:11:36+01:00", statut: "accepte", enregistrement: { statut: "abandonne" } }] };
    expect(validerLotParcours(lot11([{ ...exemple11(), upsell }]))).toBe(true);
    expect(validerLotParcours({ ...lot11([{ ...exemple11(), reconstitue: true, paiement: { demandes: 1, statut: "refuse", montant_ttc_centimes: 350, passages: [{ statut: "refuse" }] } }]), rattrapage: true })).toBe(true);
    // Les champs 1.1 restent acceptés dans une enveloppe 1.0
    expect(validerLotParcours(JSON.parse(JSON.stringify(lot([exemple11()]))))).toBe(true);
  });

  it("1.1 : refuse une version inconnue, un rendu ou une fermeture hors liste, un passage sans statut", () => {
    expect(validerLotParcours({ ...lot11([exemple11()]), schema_version: "1.2" })).toBe(false);
    expect(validerLotParcours(lot11([{ ...exemple11(), rendu: "sepia" }]))).toBe(false);
    expect(validerLotParcours(lot11([{ ...exemple11(), offre_fermeture: "fermee" }]))).toBe(false);
    expect(validerLotParcours(lot11([{ ...exemple11(), paiement: { demandes: 1, statut: "refuse", montant_ttc_centimes: 350, passages: [{ demande: "2026-11-10T23:10:56+01:00" }] } }]))).toBe(false);
  });

  it("sansChamps11 rend le parcours 1.0 d'origine", () => {
    const original = exemple();
    const reconstitue = { ...original, rendu: "couleur", offre_fermeture: "non_merci", reconstitue: true, paiement: { ...original.paiement, passages: [{ statut: "accepte" }] }, upsell: { ...original.upsell, passages: [{ statut: "accepte" }] } };
    expect(sansChamps11(reconstitue as unknown as ParcoursJson)).toEqual(original);
  });

  it("une ligne fautive est isolée, le reste du lot passe", () => {
    expect(validerLotParcours(lot([exemple(), { ...exemple(), parcours_id: "S513-20261022-ZZZZZZ", issue: "perdue" }]))).toBe(false);
    const erreurs = validerLotParcours.errors ?? [];
    expect(erreursUniquementSurLignes(erreurs, "parcours")).toBe(true);
    expect([...erreursParLigne(erreurs, "parcours").keys()]).toEqual([1]);
  });
});
