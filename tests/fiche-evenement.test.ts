import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { initialiserReferentiel } from "../src/referentiel/initial.js";
import { viderBase } from "./aide.js";

// Fiche événement d'un lieu : enregistrement, config.json, publication (CDC page souvenir § 13)
const app = creerApp();
const api = request(app);
afterAll(() => prisma.$disconnect());

let lieuId: number;

beforeEach(async () => {
  await viderBase();
  await initialiserReferentiel();
  const bar = await prisma.refValeur.findFirstOrThrow({ where: { categorie: "TYPE_LIEU", code: "BAR" } });
  lieuId = (
    await prisma.lieu.create({
      data: {
        raisonSociale: "La Ruche SAS", enseigne: "La Ruche", ville: "Trégueux", typeLieuId: bar.id, dateInstallation: new Date("2026-10-06T00:00:00Z"),
        horaires: { create: [{ jourSemaine: 6, ouverture: new Date("1970-01-01T22:00:00Z"), fermeture: new Date("1970-01-01T05:00:00Z") }] },
      },
    })
  ).id;
});

describe("fiche événement", () => {
  it("propose des réglages par défaut tirés de la fiche, sans code tant que rien n'est enregistré", async () => {
    const r = (await api.get(`/api/lieux/${lieuId}/evenement`).expect(200)).body;
    expect(r).toMatchObject({ enregistre: false, code: null, version: 0 });
    expect(r.reglages.lieu).toMatchObject({ nom: "La Ruche", ville: "Trégueux", dateDebut: "2026-10-06", dateFin: "2028-10-06" });
    expect(r.horaires).toEqual([{ jourSemaine: 6, ouverture: "22:00", fermeture: "05:00" }]);
  });

  it("enregistre, attribue un code R…, génère le config.json et publie une version", async () => {
    const { reglages } = (await api.get(`/api/lieux/${lieuId}/evenement`)).body;
    reglages.lieu.avisGoogleUrl = "https://g.page/r/exemple/review";
    const e = (await api.put(`/api/lieux/${lieuId}/evenement`).send({ reglages }).expect(200)).body;
    expect(e.code).toMatch(/^R[A-Z2-9]{3}$/);
    expect(e.modifieDepuisPublication).toBe(true);

    const config = JSON.parse((await api.get(`/api/lieux/${lieuId}/evenement/config.json`).expect(200)).text);
    expect(config.event).toMatchObject({ code: e.code, name: "LA RUCHE" });
    expect(config.userSettings.openingHours).toEqual([{ day: 6, open: "22:00", close: "05:00" }]);

    const p = (await api.post(`/api/lieux/${lieuId}/evenement/publier`).expect(200)).body;
    expect(p).toMatchObject({ version: 1, modifieDepuisPublication: false });
    expect(JSON.parse((await api.get(`/api/lieux/${lieuId}/evenement/config.json?publiee=1`).expect(200)).text).event.code).toBe(e.code);

    // Une modification après publication se voit ; le code ne change pas
    reglages.tarifs.plusUnCents = 250;
    const m = (await api.put(`/api/lieux/${lieuId}/evenement`).send({ reglages }).expect(200)).body;
    expect(m).toMatchObject({ code: e.code, version: 1, modifieDepuisPublication: true });
  });

  it("refuse de publier quand un contrôle bloque", async () => {
    const { reglages } = (await api.get(`/api/lieux/${lieuId}/evenement`)).body;
    reglages.gabarits = { choisis: [], accueil: [] };
    await api.put(`/api/lieux/${lieuId}/evenement`).send({ reglages }).expect(200);
    const r = (await api.post(`/api/lieux/${lieuId}/evenement/publier`).expect(400)).body;
    expect(r.error).toBe("CONTROLES");
    expect(r.message).toMatch(/au moins un gabarit/);
  });

  it("crée un événement ponctuel : son code, les réglages de l'habituel, les tarifs du lieu, pas de cadre", async () => {
    const { reglages } = (await api.get(`/api/lieux/${lieuId}/evenement`)).body;
    reglages.lieu.avisGoogleUrl = "https://g.page/r/exemple/review";
    const habituel = (await api.put(`/api/lieux/${lieuId}/evenement`).send({ reglages }).expect(200)).body;

    const h = (await api.post(`/api/lieux/${lieuId}/evenements-ponctuels`).send({ nom: "Halloween", dateDebut: "2026-10-31", dateFin: "2026-11-01" }).expect(201)).body;
    expect(h).toMatchObject({ habituel: false, nom: "Halloween", version: 0 });
    expect(h.code).not.toBe(habituel.code);
    expect(h.reglages.lieu).toMatchObject({ avisGoogleUrl: "https://g.page/r/exemple/review", dateDebut: "2026-10-31", dateFin: "2026-11-01" });
    expect(h.reglages.tarifs.herite).toBe(true);

    // Trois polas : un même gabarit plusieurs fois
    h.reglages.gabarits = { choisis: [{ id: "pola", gabarit: "pola" }, { id: "pola-a1", gabarit: "pola" }, { id: "pola-b2", gabarit: "pola" }], accueil: ["pola-b2"] };
    await api.put(`/api/lieux/${lieuId}/evenements-ponctuels/${h.id}`).send({ reglages: h.reglages, nom: "Halloween 2026" }).expect(200);
    const config = JSON.parse((await api.get(`/api/lieux/${lieuId}/evenements-ponctuels/${h.id}/config.json`).expect(200)).text);
    expect(config.event).toMatchObject({ code: h.code, name: "LA RUCHE · HALLOWEEN 2026" });
    expect(config.compositions).toHaveLength(3);

    const liste = (await api.get(`/api/lieux/${lieuId}/evenements-ponctuels`).expect(200)).body;
    expect(liste).toMatchObject([{ id: h.id, nom: "Halloween 2026", code: h.code, dateDebut: "2026-10-31" }]);
    // L'habituel n'a pas bougé
    expect((await api.get(`/api/lieux/${lieuId}/evenement`).expect(200)).body.code).toBe(habituel.code);

    await api.delete(`/api/lieux/${lieuId}/evenements-ponctuels/${h.id}`).expect(204);
    await api.get(`/api/lieux/${lieuId}/evenements-ponctuels/${h.id}`).expect(404);
  });

  it("est réservée aux admins", async () => {
    await prisma.user.create({ data: { email: "commercial@test.fr", nom: "C", prenom: "C", role: "COMMERCIAL" } });
    await api.get(`/api/lieux/${lieuId}/evenement`).set("X-Dev-Utilisateur", "commercial@test.fr").expect(403);
  });
});
