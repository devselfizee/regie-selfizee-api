import { describe, expect, it } from "vitest";
import { codeDepuisSymbole, departement, joursDepuisMetNorway, lireFichierMeteoFrance, meteoDuLieu } from "../src/calendrier/meteo.js";

// Extrait au format réel du fichier quotidien Météo-France (Q_44_latest-…_RR-T-Vent.csv)
const ENTETE =
  "NUM_POSTE;NOM_USUEL;LAT;LON;ALTI;AAAAMMJJ;RR;QRR;TN;QTN;HTN;QHTN;TX;QTX;HTX;QHTX;TM;QTM;TNTXM;QTNTXM;TAMPLI;QTAMPLI;TNSOL;QTNSOL;TN50;QTN50;DG;QDG";
const ligne = (poste: string, nom: string, lat: number, lon: number, date: string, rr: string, tn: string, tx: string) =>
  [poste, nom, lat, lon, 10, date, rr, 1, tn, 1, "", "", tx, 1, "", "", "", "", "", "", "", "", "", "", "", "", "", ""].join(";");
const CSV = [
  ENTETE,
  // Saint-Nazaire : pluie et températures ; La Baule pluviomètre seul (plus proche du lieu)
  ligne("44184001", "ST NAZAIRE-MONTOIR", 47.312, -2.149, "20261005", "0.0", "9.1", "18.4"),
  ligne("44184001", "ST NAZAIRE-MONTOIR", 47.312, -2.149, "20261006", "12.5", "11.0", "16.2"),
  ligne("44055001", "LA BAULE", 47.29, -2.39, "20261005", "0.4", "", ""),
  ligne("44055001", "LA BAULE", 47.29, -2.39, "20261006", "", "", ""),
  ligne("44055001", "LA BAULE", 47.29, -2.39, "20240101", "3.0", "", ""), // trop ancien
  ligne("44020001", "NANTES", 47.15, -1.6, "20261005", "5.0", "8.0", "20.0"), // à plus de 40 km
].join("\n");

describe("Météo-France : relevés quotidiens", () => {
  it("lit le fichier et ignore les jours trop anciens", () => {
    const stations = lireFichierMeteoFrance(CSV, "2025-01-01");
    expect(stations.map((s) => s.nom).sort()).toEqual(["LA BAULE", "NANTES", "ST NAZAIRE-MONTOIR"]);
    expect(stations.find((s) => s.nom === "LA BAULE")!.jours.has("2024-01-01")).toBe(false);
  });

  it("chaque mesure vient de la station la plus proche qui l'a ce jour-là", () => {
    const jours = meteoDuLieu(lireFichierMeteoFrance(CSV, "2025-01-01"), { latitude: 47.2888, longitude: -2.3906 });
    expect(jours).toEqual([
      // pluie de La Baule (sur place), températures de Saint-Nazaire (18 km) ; Nantes (60 km) ignorée
      { jour: "2026-10-05", tempMax: 18.4, tempMin: 9.1, precipitationMm: 0.4, codeWmo: null },
      // La Baule n'a pas de relevé ce jour-là : Saint-Nazaire prend le relais
      { jour: "2026-10-06", tempMax: 16.2, tempMin: 11, precipitationMm: 12.5, codeWmo: null },
    ]);
  });

  it("département d'après le code postal, Corse et outre-mer compris", () => {
    expect(departement("44500")).toBe("44");
    expect(departement("20000")).toBe("20");
    expect(departement("97400")).toBe("974");
    expect(departement(null)).toBeNull();
  });
});

describe("MET Norway : prévisions", () => {
  const pas = (time: string, t: number, pluie1: number | null, pluie6: number | null, symbole = "cloudy") => ({
    time,
    data: {
      instant: { details: { air_temperature: t } },
      ...(pluie1 !== null ? { next_1_hours: { summary: { symbol_code: symbole }, details: { precipitation_amount: pluie1 } } } : {}),
      ...(pluie6 !== null ? { next_6_hours: { summary: { symbol_code: symbole }, details: { precipitation_amount: pluie6 } } } : {}),
    },
  });

  it("regroupe par jour de Paris sans compter deux fois la pluie", () => {
    const jours = joursDepuisMetNorway([
      // pas horaires : on additionne la pluie de l'heure suivante (pas celle des 6 h, qui la recouvre)
      pas("2026-10-13T10:00:00Z", 14, 0.5, 3, "lightrain_day"),
      pas("2026-10-13T11:00:00Z", 17, 1, 3, "lightrain_day"),
      pas("2026-10-13T12:00:00Z", 15, null, 2, "rain"),
      // puis par 6 h : 12 h → 18 h UTC
      pas("2026-10-13T18:00:00Z", 12, null, 0, "clearsky_night"),
      pas("2026-10-14T00:00:00Z", 9, null, 0, "clearsky_night"),
    ]);
    expect(jours[0]).toEqual({ jour: "2026-10-13", tempMax: 17, tempMin: 12, precipitationMm: 3.5, codeWmo: 61 }); // temps de 12 h à Paris : pluie faible
    expect(jours[1].jour).toBe("2026-10-14"); // 00 h UTC = 2 h à Paris
  });

  it("symboles vers types de temps", () => {
    expect(codeDepuisSymbole("clearsky_day")).toBe(0);
    expect(codeDepuisSymbole("partlycloudy_night")).toBe(2);
    expect(codeDepuisSymbole("heavyrainshowers_day")).toBe(65);
    expect(codeDepuisSymbole("lightsnow")).toBe(71);
    expect(codeDepuisSymbole("rainandthunder")).toBe(95);
    expect(codeDepuisSymbole(undefined)).toBeNull();
  });
});
