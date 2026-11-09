import { describe, expect, it } from "vitest";
import { disponibilite } from "../src/stats/disponibilite.js";

// Disponibilité d'une borne : calcul pur, sans base de données
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const heure = (h: string) => new Date(`1970-01-01T${h}:00Z`);

describe("disponibilité d'une borne", () => {
  const lieu = { saisonnalite: "ANNUEL" as const, saisons: [], fermetures: [], horaires: [1, 2, 3, 4, 5, 6, 7].map((j) => ({ jourSemaine: j, ouverture: heure("10:00"), fermeture: heure("22:00") })) };
  // Mercredi 7 octobre 2026 (Paris = UTC+2) : un heartbeat toutes les 5 min de 10 h à 22 h, sauf de 14 h à 15 h
  const hbs: Date[] = [];
  for (let m = 0; m < 12 * 60; m += 5) {
    const t = new Date(Date.UTC(2026, 9, 7, 8, 0) + m * 60_000);
    const heureParis = 10 + Math.floor(m / 60);
    if (heureParis !== 14) hbs.push(t);
  }
  hbs.push(new Date("2026-10-07T23:00:00Z"), new Date("2026-10-08T08:05:00Z")); // la nuit (ignoré), puis le lendemain matin

  it("rapporte le temps en ligne au temps d'ouverture et repère les coupures", () => {
    const r = disponibilite(lieu, { debut: d("2026-01-01"), fin: null }, d("2026-10-07"), d("2026-10-07"), hbs, new Date("2026-10-07T23:59:00Z"));
    expect(r.minutesAttendues).toBe(720);
    // Hors ligne au-delà de 15 min sans signal : de 14 h 15 à 15 h
    expect(r.minutesEnLigne).toBe(675);
    expect(r.taux).toBeCloseTo(675 / 720);
    expect(r.coupures).toBe(1); // le silence de la nuit ne compte pas
    expect(r.plusLongueCoupureMin).toBe(45);
  });

  it("compte comme coupure une borne allumée après l'ouverture : taux et coupures se recoupent", () => {
    // Allumée à 16 h seulement (14 h UTC), jusqu'à la fermeture
    const tard = hbs.filter((h) => h >= new Date("2026-10-07T14:00:00Z") && h < new Date("2026-10-07T20:00:00Z"));
    const r = disponibilite(lieu, { debut: d("2026-01-01"), fin: null }, d("2026-10-07"), d("2026-10-07"), tard, new Date("2026-10-07T23:59:00Z"));
    expect(r.minutesEnLigne).toBe(360);
    expect(r.taux).toBeCloseTo(0.5);
    expect(r.coupures).toBe(1);
    expect(r.plusLongueCoupureMin).toBe(360); // de 10 h à 16 h
  });

  it("ne compte que les jours où la borne était dans le lieu", () => {
    const r = disponibilite(lieu, { debut: d("2026-10-07"), fin: d("2026-10-08") }, d("2026-10-01"), d("2026-10-10"), hbs, new Date("2026-10-31T00:00:00Z"));
    expect(r.minutesAttendues).toBe(720); // seulement le 7
  });
});
