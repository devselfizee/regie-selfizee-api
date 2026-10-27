import { readFileSync } from "node:fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reglagesParDefaut } from "../src/config-evenement/reglages.js";
import { lireModele } from "../src/config-evenement/generation.js";

// Route « Télécharger le config.json » de la fiche événement, de bout en bout dans l'application Express,
// avec une base simulée (pas de base de données) : brouillon généré avec les cadres du studio, version publiée.

const canvas = readFileSync(new URL("./fixtures/cadre-bandelette.json", import.meta.url), "utf8");
const reglages = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
reglages.gabarits.choisis = ["bandelette", "pola"];

const base = vi.hoisted(() => {
  // Sans Keycloak : l'application prend l'utilisateur de développement (admin)
  delete process.env.KEYCLOAK_URL;
  return { lieu: null as unknown, cadres: [] as unknown[] };
});
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { upsert: async () => ({ id: 1, email: "dev@local", nom: "Dev", prenom: "", role: "ADMIN", lieuId: null, isActive: true, keycloakSub: null }) },
    lieu: { findUnique: async () => base.lieu },
    cadreEvenement: { findMany: async () => base.cadres },
  },
}));
const { creerApp } = await import("../src/app.js");
const api = request(creerApp());

const fiche = (configEvenement: unknown) => ({
  id: 7, enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z"),
  horaires: [{ jourSemaine: 6, ouverture: new Date("1970-01-01T22:00:00Z"), fermeture: new Date("1970-01-01T05:00:00Z") }],
  configEvenement,
});
const enregistree = { code: "RA7K", motDePasseTableau: "MDP23456", reglages, version: 0, publieeLe: null, configPubliee: null, updatedAt: new Date("2026-10-27T10:00:00Z") };

beforeEach(() => {
  base.lieu = fiche(enregistree);
  base.cadres = [{ gabarit: "bandelette", canvas }];
});

describe("GET /api/lieux/:id/evenement/config.json", () => {
  it("télécharge le config.json du brouillon, avec les zones du cadre de la bandelette", async () => {
    const r = await api.get("/api/lieux/7/evenement/config.json").expect(200);
    expect(r.headers["content-disposition"]).toBe('attachment; filename="config-RA7K.json"');
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    const config = JSON.parse(r.text);
    expect(config.event).toMatchObject({ code: "RA7K", name: "LA RUCHE", updateDate: "2026-10-27 11:00:00" });
    expect(config.compositions).toHaveLength(2);
    // Bandelette : 4 zones du cadre (x = 50) + 4 mini-photos de la carte souvenir du kit
    expect(config.compositions[0].holes.slice(0, 4).map((h: { x: number }) => h.x)).toEqual([50, 50, 50, 50]);
    expect(config.compositions[0].qrHoles).toEqual(lireModele().gabarits.bandelette.qrHoles);
    // Pola sans cadre : celui du kit
    expect(config.compositions[1]).toEqual(lireModele().gabarits.pola);
    expect(config.userSettings.openingHours).toEqual([{ day: 6, open: "22:00", close: "05:00" }]);
  });

  it("sans cadre, les compositions sont celles du kit", async () => {
    base.cadres = [];
    const config = JSON.parse((await api.get("/api/lieux/7/evenement/config.json").expect(200)).text);
    expect(config.compositions[0]).toEqual(lireModele().gabarits.bandelette);
  });

  it("?publiee=1 renvoie la version figée à la publication", async () => {
    base.lieu = fiche({ ...enregistree, version: 1, configPubliee: { event: { code: "RA7K" }, figee: true } });
    const config = JSON.parse((await api.get("/api/lieux/7/evenement/config.json?publiee=1").expect(200)).text);
    expect(config).toEqual({ event: { code: "RA7K" }, figee: true });
  });

  it("fiche jamais enregistrée : 404 avec un message clair", async () => {
    base.lieu = fiche(null);
    const r = await api.get("/api/lieux/7/evenement/config.json").expect(404);
    expect(r.body).toMatchObject({ error: "PAS_ENCORE_ENREGISTRE" });
  });
});
