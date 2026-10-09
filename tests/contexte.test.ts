import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import type { OuvertureLieu } from "../src/alertes/ouverture.js";
import { joursFeries, paques, periodeVacances, zoneScolaire } from "../src/calendrier/calendrier.js";
import { effets, indicesJournaliers, type ContexteJour } from "../src/calendrier/contexte.js";
import { impact } from "../src/evenements/impact.js";
import { viderBase } from "./aide.js";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);
const JOUR = 86_400_000;
const ouvert: OuvertureLieu = { saisonnalite: "ANNUEL", horaires: [], saisons: [], fermetures: [] };
const sans: ContexteJour = { ferie: null, vacances: null, meteo: null };

function serie(du: string, au: string, f: (j: Date) => number) {
  const m = new Map<string, number>();
  for (let t = d(du).getTime(); t <= d(au).getTime(); t += JOUR) m.set(ymd(new Date(t)), f(new Date(t)));
  return m;
}

afterAll(() => prisma.$disconnect());

describe("calendrier", () => {
  it("jours fériés, Pâques comprise", () => {
    expect(ymd(paques(2026))).toBe("2026-04-05");
    expect(ymd(paques(2027))).toBe("2027-03-28");
    const f = joursFeries(2026);
    expect(f.size).toBe(11);
    expect(f.get("2026-04-06")).toBe("Lundi de Pâques");
    expect(f.get("2026-05-14")).toBe("Ascension");
    expect(f.get("2026-05-25")).toBe("Lundi de Pentecôte");
    expect(f.get("2026-07-14")).toBe("Fête nationale");
  });

  it("zone scolaire d'après le code postal", () => {
    expect(zoneScolaire("44500")).toBe("B"); // La Baule
    expect(zoneScolaire("33000")).toBe("A"); // Bordeaux
    expect(zoneScolaire("75011")).toBe("C");
    expect(zoneScolaire("20000")).toBe("CORSE");
    expect(zoneScolaire("97400")).toBeNull();
    expect(zoneScolaire(null)).toBeNull();
  });

  it("période de vacances : la date de fin du jeu de données est celle de la reprise", () => {
    expect(periodeVacances({ start_date: "2025-10-17T22:00:00+00:00", end_date: "2025-11-02T23:00:00+00:00" })).toEqual({ debut: d("2025-10-18"), fin: d("2025-11-02") });
  });
});

describe("effets du calendrier et de la météo", () => {
  it("compare chaque jour au même jour de semaine voisin, puis par catégorie", () => {
    // CA de base 100 €, le samedi 300 € ; pluie un jour sur 4 (CA −40 %) ; vacances en août (+50 %)
    const pluie = (j: Date) => (j.getTime() / JOUR) % 4 === 0;
    const vacances = (j: Date) => j.getUTCMonth() === 7;
    const hist = serie("2026-06-01", "2026-09-30", (j) => (j.getUTCDay() === 6 ? 30000 : 10000) * (pluie(j) ? 0.6 : 1) * (vacances(j) ? 1.5 : 1));
    const contexte = (s: string): ContexteJour => ({
      ferie: s === "2026-07-14" ? "Fête nationale" : null,
      vacances: vacances(d(s)) ? "Vacances d'été" : null,
      meteo: { tempMax: 20, precipitationMm: pluie(d(s)) ? 8 : 0, codeWmo: 0, prevision: false },
    });
    const indices = indicesJournaliers(ouvert, hist, null, d("2026-07-01"), d("2026-08-31"), d("2026-09-30"), contexte);
    expect(indices.length).toBe(62);
    const e = effets(indices);
    expect(e.pluie.effet).toBeLessThan(-0.3);
    expect(e.pluie.effet).toBeGreaterThan(-0.5);
    expect(e.vacances.effet).toBeGreaterThan(0.15); // amorti : les références d'août sont aussi en vacances
    expect(e.feries.effet).toBeNull(); // un seul férié : effectif insuffisant
    expect(e.temperatures.find((t) => t.tranche === "18 à 25 °C")).toMatchObject({ n: 62, effet: null });
  });

  it("ignore les jours fermés, à venir et d'avant l'installation", () => {
    const hist = serie("2026-06-01", "2026-09-30", () => 10000);
    const lundiFerme: OuvertureLieu = { ...ouvert, horaires: [2, 3, 4, 5, 6, 7].map((j) => ({ jourSemaine: j, ouverture: d("1970-01-01"), fermeture: d("1970-01-01") })) };
    const indices = indicesJournaliers(lundiFerme, hist, d("2026-07-01"), d("2026-06-15"), d("2026-07-31"), d("2026-07-20"), () => sans);
    expect(indices.every((i) => i.jour >= "2026-07-01" && i.jour <= "2026-07-20")).toBe(true);
    expect(indices.some((i) => d(i.jour).getUTCDay() === 1)).toBe(false);
  });
});

describe("impact d'un événement", () => {
  const ventes = (f: (j: Date) => [number, number]) => {
    const m = new Map<string, { caCents: number; nbVentes: number }>();
    for (let t = d("2026-05-01").getTime(); t <= d("2026-09-30").getTime(); t += JOUR) {
      const [ca, nb] = f(new Date(t));
      m.set(ymd(new Date(t)), { caCents: ca, nbVentes: nb });
    }
    return m;
  };

  it("ponctuel : CA du jour contre le même jour habituel", () => {
    const v = ventes((j) => (ymd(j) === "2026-07-18" ? [45000, 50] : [15000, 20]));
    expect(impact(ouvert, v, null, d("2026-07-18"), d("2026-07-18"), d("2026-09-30"))).toEqual({ type: "PONCTUEL", caCents: 45000, habituelCents: 15000, effet: 2 });
  });

  it("changement de prix : 4 semaines avant / après", () => {
    // Prix de 6 € à 8 € le 1er juillet : 25 ventes/jour → 22
    const v = ventes((j) => (j >= d("2026-07-01") ? [22 * 800, 22] : [25 * 600, 25]));
    const r = impact(ouvert, v, null, d("2026-07-01"), null, d("2026-09-30"));
    expect(r).toMatchObject({ type: "DURABLE", avant: { jours: 28, panierMoyenCents: 600 }, apres: { jours: 28, panierMoyenCents: 800, ventesParJour: 22 } });
    if (r.type !== "DURABLE") throw new Error();
    expect(r.effetCa).toBeCloseTo(17600 / 15000 - 1);
    expect(r.effetVentes).toBeCloseTo(-0.12);
  });

  it("trop récent ou à venir", () => {
    const v = ventes(() => [10000, 10]);
    expect(impact(ouvert, v, null, d("2026-09-27"), null, d("2026-09-30"))).toEqual({ type: "EN_COURS", joursObserves: 4 });
    expect(impact(ouvert, v, null, d("2026-10-10"), null, d("2026-09-30"))).toEqual({ type: "A_VENIR" });
  });
});

describe("routes", () => {
  const app = creerApp();
  const api = request(app);
  let lieuId: number;
  let prix: number;

  beforeEach(async () => {
    await viderBase();
    await prisma.vacancesScolaires.deleteMany();
    const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "BAR", libelle: "Bar" } });
    prix = (await prisma.refValeur.create({ data: { categorie: "TYPE_EVENEMENT", code: "PRIX", libelle: "Changement de prix" } })).id;
    lieuId = (await prisma.lieu.create({ data: { raisonSociale: "SAS", enseigne: "Bar du Port", typeLieuId: type.id, codePostal: "44500", latitude: 47.28, longitude: -2.39 } })).id;
    await prisma.user.create({ data: { email: "part@test.fr", nom: "P", prenom: "P", role: "PARTENAIRE", lieuId } });
  });

  it("journal d'événements : saisie, droits, impact", async () => {
    const cree = await api.post(`/api/lieux/${lieuId}/evenements`).send({ typeId: prix, libelle: "Bande à 8 €", debut: "2026-07-01" }).expect(201);
    await api.post(`/api/lieux/${lieuId}/evenements`).send({ typeId: prix, libelle: "x", debut: "2026-07-05", fin: "2026-07-01" }).expect(400);
    await api.post(`/api/lieux/${lieuId}/evenements`).set("X-Dev-Utilisateur", "part@test.fr").send({ typeId: prix, libelle: "x", debut: "2026-07-01" }).expect(403);

    const liste = (await api.get(`/api/lieux/${lieuId}/evenements`).set("X-Dev-Utilisateur", "part@test.fr").expect(200)).body;
    expect(liste[0]).toMatchObject({ libelle: "Bande à 8 €", debut: "2026-07-01", fin: null, type: { code: "PRIX" }, impact: { type: "DURABLE" } });

    await api.put(`/api/evenements/${cree.body.id}`).send({ typeId: prix, libelle: "Bande à 8 €", debut: "2026-07-01", fin: "2026-07-02" }).expect(200);
    expect((await api.get(`/api/lieux/${lieuId}/evenements`).expect(200)).body[0]).toMatchObject({ fin: "2026-07-02", impact: { type: "PONCTUEL" } });
    await api.delete(`/api/evenements/${cree.body.id}`).expect(204);
  });

  it("contexte d'un lieu : zone, vacances et météo jour par jour", async () => {
    await prisma.vacancesScolaires.create({ data: { zone: "B", libelle: "Vacances d'Été", anneeScolaire: "2025-2026", debut: d("2026-07-04"), fin: d("2026-08-31") } });
    await prisma.meteoJour.create({ data: { lieuId, jour: d("2026-07-10"), tempMax: 27, precipitationMm: 0, codeWmo: 0 } });
    const r = (await api.get(`/api/stats/contexte/lieux/${lieuId}?du=2026-07-01&au=2026-07-31`).expect(200)).body;
    expect(r).toMatchObject({ zoneScolaire: "B", geolocalise: true, effets: { jours: 0 } });
    expect(r.jours.find((j: { jour: string }) => j.jour === "2026-07-10")).toMatchObject({ vacances: "Vacances d'Été", temps: "Ensoleillé", meteo: { tempMax: 27 } });
    expect(r.jours.find((j: { jour: string }) => j.jour === "2026-07-14")).toMatchObject({ ferie: "Fête nationale" });
    expect((await api.get("/api/stats/contexte?du=2026-07-01&au=2026-07-31").expect(200)).body.ensemble).toMatchObject({ lieux: 0 });
  });
});
