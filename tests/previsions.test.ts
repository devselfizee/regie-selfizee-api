import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import type { OuvertureLieu } from "../src/alertes/ouverture.js";
import { dateAtteinte, prevoir } from "../src/previsions/prevision.js";
import { viderBase } from "./aide.js";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);
const JOUR = 86_400_000;
const ouvertTousLesJours: OuvertureLieu = { saisonnalite: "ANNUEL", horaires: [], saisons: [], fermetures: [] };
const h = (hh: number) => new Date(Date.UTC(1970, 0, 1, hh));

/** Historique : `ca(jour)` en centimes pour chaque jour de [du, au]. */
function historique(du: string, au: string, ca: (j: Date) => number) {
  const m = new Map<string, number>();
  for (let t = d(du).getTime(); t <= d(au).getTime(); t += JOUR) {
    const v = ca(new Date(t));
    if (v) m.set(ymd(new Date(t)), v);
  }
  return m;
}

afterAll(() => prisma.$disconnect());

describe("prévision du CA", () => {
  // Le 15 octobre 2026 est un jeudi
  const aujourdhui = d("2026-10-15");

  it("profil par jour de la semaine, réalisé jusqu'à aujourd'hui compris", () => {
    // Samedi 200 €, autres jours 50 €
    const hist = historique("2026-08-01", "2026-10-14", (j) => (j.getUTCDay() === 6 ? 20000 : 5000));
    const p = prevoir(ouvertTousLesJours, hist, null, d("2026-10-01"), d("2026-10-31"), aujourdhui);
    expect(p.realiseCents).toBe(2 * 20000 + 12 * 5000); // 1-14 oct : 2 samedis
    // Du 15 au 31 : 3 samedis (17, 24, 31) et 14 autres jours
    expect(p.restantCents).toBe(3 * 20000 + 14 * 5000);
    expect(p.totalCents).toBe(p.realiseCents + p.restantCents);
    expect(p.basseCents).toBe(p.totalCents); // aucune dispersion
    expect(p.fiable).toBe(true);
    expect(p.arretDepuis).toBeNull();
    expect(p.jours.find((j) => j.jour === "2026-10-17")).toMatchObject({ realiseCents: null, prevuCents: 20000 });
  });

  it("ne prévoit rien les jours fermés, et seulement le complément le jour même", () => {
    const hist = historique("2026-08-01", "2026-10-15", (j) => (j.getUTCDay() === 1 ? 0 : j.getTime() === aujourdhui.getTime() ? 3000 : 10000));
    // Fermé le lundi ; fermeture exceptionnelle du 20 au 22
    const lieu: OuvertureLieu = {
      ...ouvertTousLesJours,
      horaires: [2, 3, 4, 5, 6, 7].map((j) => ({ jourSemaine: j, ouverture: h(10), fermeture: h(20) })),
      fermetures: [{ debut: d("2026-10-20"), fin: d("2026-10-22") }],
    };
    const p = prevoir(lieu, hist, null, d("2026-10-15"), d("2026-10-25"), aujourdhui);
    const prevu = Object.fromEntries(p.jours.map((j) => [j.jour, j.prevuCents]));
    expect(prevu["2026-10-15"]).toBe(7000); // 100 € attendus, 30 € déjà faits
    expect(prevu["2026-10-19"]).toBe(0); // lundi
    expect(prevu["2026-10-21"]).toBe(0); // fermeture
    expect(p.joursOuvertsRestants).toBe(7); // 15→25 : 11 jours − 1 lundi − 3 jours de fermeture
  });

  it("corrige avec la saisonnalité de l'année précédente", () => {
    // N-1 : 100 €/jour jusqu'à mi-octobre, puis 50 €/jour ; cette année : 120 €/jour
    const hist = historique("2025-07-01", "2026-10-14", (j) =>
      j < d("2026-01-01") ? (j < d("2025-10-16") ? 10000 : 5000) : 12000
    );
    const p = prevoir(ouvertTousLesJours, hist, null, d("2026-10-01"), d("2026-11-30"), aujourdhui);
    const prevu = (j: string) => p.jours.find((x) => x.jour === j)!.prevuCents;
    expect(prevu("2026-11-15")).toBe(6000); // 120 € × (50 / 100)
    expect(p.correctionSaisonniere).toBeLessThan(1);
  });

  it("n'utilise pas les jours d'avant l'installation", () => {
    const hist = historique("2026-10-01", "2026-10-14", () => 8000);
    const p = prevoir(ouvertTousLesJours, hist, d("2026-10-01"), d("2026-10-15"), d("2026-10-16"), aujourdhui);
    expect(p.restantCents).toBe(16000);
    expect(p.fiable).toBe(false); // 14 jours d'historique seulement
  });

  it("activité arrêtée : plus aucune vente depuis 7 jours d'ouverture", () => {
    const hist = historique("2026-08-01", "2026-10-05", () => 10000);
    const p = prevoir(ouvertTousLesJours, hist, null, d("2026-10-01"), d("2026-10-31"), aujourdhui);
    expect(p.arretDepuis).toBe("2026-10-06");
    expect(p.restantCents).toBe(0);
    expect(p.totalCents).toBe(50000);
  });

  it("date d'atteinte d'un seuil", () => {
    const hist = historique("2026-08-01", "2026-10-14", () => 10000);
    const p = prevoir(ouvertTousLesJours, hist, null, d("2026-10-01"), d("2026-10-31"), aujourdhui);
    expect(dateAtteinte(p, 0, 50000)).toEqual({ statut: "ATTEINT", jour: "2026-10-05" });
    expect(dateAtteinte(p, 0, 200000)).toEqual({ statut: "PREVU", jour: "2026-10-20" });
    expect(dateAtteinte(p, 150000, 200000)).toEqual({ statut: "ATTEINT", jour: "2026-10-05" }); // seuil cumulé
    expect(dateAtteinte(p, 0, 400000)).toEqual({ statut: "NON_ATTEINT", manqueCents: 90000 });
    expect(dateAtteinte(p, 0, 200000, 0.5)).toEqual({ statut: "NON_ATTEINT", manqueCents: 45000 }); // base HT
  });
});

describe("routes de prévision", () => {
  const app = creerApp();
  const api = request(app);

  it("global dans le périmètre, commission cachée au commercial", async () => {
    await viderBase();
    const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "BAR", libelle: "Bar" } });
    const commercial = await prisma.user.create({ data: { email: "co@test.fr", nom: "Co", prenom: "Com", role: "COMMERCIAL" } });
    const [a, b] = await Promise.all(
      ["Bar A", "Bar B"].map((enseigne, i) =>
        prisma.lieu.create({ data: { raisonSociale: "SAS", enseigne, typeLieuId: type.id, commercialId: i === 0 ? commercial.id : null } })
      )
    );
    await api.post(`/api/commissions/lieux/${a.id}/contrats`).send({ modele: "POURCENTAGE", tauxBp: 1000, periodicite: "MOIS", dateEffet: "2026-01-01" }).expect(201);

    const admin = (await api.get("/api/previsions/global").expect(200)).body;
    expect(admin.lieux.map((l: { enseigne: string }) => l.enseigne).sort()).toEqual(["Bar A", "Bar B"]);
    expect((await api.get(`/api/previsions/lieux/${a.id}`).expect(200)).body.commission).toMatchObject({ commissionPrevueCents: 0, seuils: [] });

    const co = (await api.get("/api/previsions/global").set("X-Dev-Utilisateur", "co@test.fr").expect(200)).body;
    expect(co.lieux.map((l: { enseigne: string }) => l.enseigne)).toEqual(["Bar A"]);
    const fiche = (await api.get(`/api/previsions/lieux/${a.id}`).set("X-Dev-Utilisateur", "co@test.fr").expect(200)).body;
    expect(fiche.commission).toBeNull();
    expect(fiche.mois.jours.length).toBeGreaterThanOrEqual(28);
    await api.get(`/api/previsions/lieux/${b.id}`).set("X-Dev-Utilisateur", "co@test.fr").expect(404);
  });
});
