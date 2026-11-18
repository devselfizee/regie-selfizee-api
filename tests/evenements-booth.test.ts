import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { initialiserReferentiel } from "../src/referentiel/initial.js";
import { viderBase } from "./aide.js";

// Créneaux d'événements booth programmés sur un lieu (avenant du 18/11/2026) : routes de l'onglet Configuration.
// Base de test réelle. Sans Keycloak : X-Dev-Utilisateur désigne l'utilisateur, X-Dev-Droits simule ses droits.

const app = creerApp();
const en = (email?: string, droits?: string) => {
  const r = (req: request.Test) => (droits ? req.set("X-Dev-Droits", droits) : req);
  const u = (req: request.Test) => (email ? req.set("X-Dev-Utilisateur", email) : req);
  return {
    get: (url: string) => r(u(request(app).get(url))),
    post: (url: string) => r(u(request(app).post(url))),
    put: (url: string) => r(u(request(app).put(url))),
    delete: (url: string) => r(u(request(app).delete(url))),
  };
};
const admin = en();

let lieuA = 0;
let lieuB = 0;
const saisie = { code: "ab12", nom: "Soirée privée", dateDebut: "2026-11-20", dateFin: "2026-11-21", heureDebut: "20:00", heureFin: "06:00" };

beforeEach(async () => {
  await viderBase();
  await initialiserReferentiel();
  const bar = await prisma.refValeur.findFirstOrThrow({ where: { categorie: "TYPE_LIEU", code: "BAR" } });
  const [a, b] = await Promise.all([
    prisma.user.create({ data: { email: "alice@test.fr", nom: "Martin", prenom: "Alice", role: "COMMERCIAL" } }),
    prisma.user.create({ data: { email: "bob@test.fr", nom: "Durand", prenom: "Bob", role: "COMMERCIAL" } }),
  ]);
  lieuA = (await prisma.lieu.create({ data: { raisonSociale: "A", enseigne: "Le A", typeLieuId: bar.id, commercialId: a.id } })).id;
  lieuB = (await prisma.lieu.create({ data: { raisonSociale: "B", enseigne: "Le B", typeLieuId: bar.id, commercialId: b.id } })).id;
});

describe("créneaux booth d'un lieu", () => {
  it("création, liste, modification, suppression ; le code est gardé en majuscules, sans vérification", async () => {
    const c = await admin.post(`/api/lieux/${lieuA}/evenements-booth`).send(saisie).expect(201);
    expect(c.body).toMatchObject({ code: "AB12", nom: "Soirée privée", origine: "booth", dateDebut: "2026-11-20", dateFin: "2026-11-21", heureDebut: "20:00", heureFin: "06:00" });
    // Le même code sur un autre lieu : permis (pas d'unicité)
    await admin.post(`/api/lieux/${lieuB}/evenements-booth`).send(saisie).expect(201);
    await admin.post(`/api/lieux/${lieuA}/evenements-booth`).send({ code: "CD34", dateDebut: "2026-12-05", dateFin: "2026-12-05" }).expect(201);

    const liste = (await admin.get(`/api/lieux/${lieuA}/evenements-booth`).expect(200)).body;
    expect(liste.map((e: { code: string; nom: string | null }) => [e.code, e.nom])).toEqual([["CD34", null], ["AB12", "Soirée privée"]]);

    const m = await admin.put(`/api/lieux/${lieuA}/evenements-booth/${c.body.id}`).send({ ...saisie, nom: "", dateFin: "2026-11-22" }).expect(200);
    expect(m.body).toMatchObject({ id: c.body.id, nom: null, dateFin: "2026-11-22" });

    await admin.delete(`/api/lieux/${lieuA}/evenements-booth/${c.body.id}`).expect(204);
    expect((await admin.get(`/api/lieux/${lieuA}/evenements-booth`).expect(200)).body).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entite: "evenement_booth" } })).toBe(5);
  });

  it("saisie refusée : code mal formé, fin avant le début, heure invalide ; créneau d'un autre lieu introuvable", async () => {
    await admin.post(`/api/lieux/${lieuA}/evenements-booth`).send({ ...saisie, code: "A-1" }).expect(400);
    await admin.post(`/api/lieux/${lieuA}/evenements-booth`).send({ ...saisie, code: "TROPLONG9" }).expect(400);
    await admin.post(`/api/lieux/${lieuA}/evenements-booth`).send({ ...saisie, dateFin: "2026-11-19" }).expect(400);
    await admin.post(`/api/lieux/${lieuA}/evenements-booth`).send({ ...saisie, heureDebut: "25:00" }).expect(400);
    await admin.post(`/api/lieux/${lieuA + lieuB + 1}/evenements-booth`).send(saisie).expect(404);
    const c = await admin.post(`/api/lieux/${lieuB}/evenements-booth`).send(saisie).expect(201);
    await admin.put(`/api/lieux/${lieuA}/evenements-booth/${c.body.id}`).send(saisie).expect(404);
    await admin.delete(`/api/lieux/${lieuA}/evenements-booth/${c.body.id}`).expect(404);
  });

  it("droits : lecture avec evenements.view, écriture avec evenements.edit ; périmètre du commercial", async () => {
    const lecteur = en("alice@test.fr", "evenements.view");
    const editeur = en("alice@test.fr", "evenements.view,evenements.edit");
    await lecteur.post(`/api/lieux/${lieuA}/evenements-booth`).send(saisie).expect(403);
    const c = await editeur.post(`/api/lieux/${lieuA}/evenements-booth`).send(saisie).expect(201);
    await lecteur.get(`/api/lieux/${lieuA}/evenements-booth`).expect(200);
    await en("alice@test.fr", "lieux.view").get(`/api/lieux/${lieuA}/evenements-booth`).expect(403);
    // Alice ne voit pas le lieu de Bob
    await editeur.get(`/api/lieux/${lieuB}/evenements-booth`).expect(404);
    await editeur.post(`/api/lieux/${lieuB}/evenements-booth`).send(saisie).expect(404);
    await lecteur.delete(`/api/lieux/${lieuA}/evenements-booth/${c.body.id}`).expect(403);
  });
});
