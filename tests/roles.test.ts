import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { genererCle } from "../src/lib/cleBorne.js";
import { exemple, viderBase } from "./aide.js";

// Sans Keycloak (tests), l'en-tête X-Dev-Utilisateur désigne l'utilisateur connecté.
const app = creerApp();
const en = (email: string) => ({
  get: (url: string) => request(app).get(url).set("X-Dev-Utilisateur", email),
  post: (url: string, body: object) => request(app).post(url).set("X-Dev-Utilisateur", email).send(body),
  put: (url: string, body: object) => request(app).put(url).set("X-Dev-Utilisateur", email).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set("X-Dev-Utilisateur", email).send(body),
});
const admin = en("admin@test.fr");
const alice = en("alice@test.fr"); // commerciale du camping
const bob = en("bob@test.fr"); // commercial du bar
const tech = en("tech@test.fr");
const part = en("camping@test.fr"); // partenaire : le camping

let camping: number;
let bar: number;
let typeId: number;
const PERIODE = "?du=2026-10-01&au=2026-10-31";

afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await viderBase();
  const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "CAMPING", libelle: "Camping" } });
  typeId = type.id;
  const [a, b] = await Promise.all([
    prisma.user.create({ data: { email: "alice@test.fr", nom: "Martin", prenom: "Alice", role: "COMMERCIAL" } }),
    prisma.user.create({ data: { email: "bob@test.fr", nom: "Durand", prenom: "Bob", role: "COMMERCIAL" } }),
    prisma.user.create({ data: { email: "admin@test.fr", nom: "Admin", prenom: "", role: "ADMIN" } }),
    prisma.user.create({ data: { email: "tech@test.fr", nom: "Tech", prenom: "", role: "TECHNICIEN" } }),
    prisma.user.create({ data: { email: "inactif@test.fr", nom: "Ancien", prenom: "", role: "ADMIN", isActive: false } }),
  ]);
  camping = (await prisma.lieu.create({ data: { raisonSociale: "C", enseigne: "Camping", typeLieuId: typeId, commercialId: a.id } })).id;
  bar = (await prisma.lieu.create({ data: { raisonSociale: "B", enseigne: "Bar", typeLieuId: typeId, commercialId: b.id } })).id;
  await prisma.user.create({ data: { email: "camping@test.fr", nom: "Gérant", prenom: "", role: "PARTENAIRE", lieuId: camping } });

  // Des ventes au camping et au bar
  const gamme = await prisma.gamme.create({ data: { code: "MT", libelle: "Ma Trombine" } });
  await prisma.typeModulePaiement.create({ data: { code: "INGENICO_SELF_2000", libelle: "Ingenico" } });
  await prisma.typeModulePaiement.create({ data: { code: "MONNAYEUR", libelle: "Monnayeur" } });
  for (const [id, lieuId] of [["MT-0042", camping], ["MT-0043", bar]] as const) {
    const k = genererCle();
    const borne = await prisma.borne.create({
      data: { identifiant: id, gammeId: gamme.id, numeroSerie: id, apiKeyHash: k.hash, apiKeyPrefix: k.prefixe },
    });
    await prisma.affectationBorne.create({ data: { borneId: borne.id, lieuId, debut: new Date("2026-01-01T00:00:00Z") } });
    await request(app)
      .post("/ingest/v1/transactions")
      .set("Authorization", `Bearer ${k.cle}`)
      .send({ ...exemple("transactions.ok.json"), borne_id: id })
      .expect(200);
  }
});

describe("accès", () => {
  it("refuse un utilisateur inconnu ou désactivé", async () => {
    expect((await en("inconnu@test.fr").get("/api/referentiel")).status).toBe(403);
    expect((await en("inactif@test.fr").get("/api/referentiel")).body.error).toBe("ACCES_NON_ACCORDE");
  });

  it("renvoie l'utilisateur connecté", async () => {
    const moi = (await alice.get("/api/utilisateurs/moi").expect(200)).body;
    expect(moi).toMatchObject({ email: "alice@test.fr", role: "COMMERCIAL" });
  });
});

describe("commercial", () => {
  it("ne voit que ses lieux", async () => {
    const lieux = (await alice.get("/api/lieux").expect(200)).body;
    expect(lieux.map((l: { enseigne: string }) => l.enseigne)).toEqual(["Camping"]);
    await alice.get(`/api/lieux/${bar}`).expect(404);
    await alice.get(`/api/stats/lieux/${bar}${PERIODE}`).expect(404);
  });

  it("n'a dans la vue globale que le CA de ses lieux, même en demandant un autre lieu", async () => {
    const tout = (await admin.get(`/api/stats/global${PERIODE}`)).body;
    const sien = (await alice.get(`/api/stats/global${PERIODE}`)).body;
    expect(tout.kpis.courant.caTtcCents).toBe(2600);
    expect(sien.kpis.courant.caTtcCents).toBe(1300);
    expect(sien.classement.map((l: { enseigne: string }) => l.enseigne)).toEqual(["Camping"]);

    const triche = (await alice.get(`/api/stats/global${PERIODE}&lieuId=${bar}`)).body;
    expect(triche.kpis.courant.caTtcCents).toBe(0);
  });

  it("n'exporte que les ventes de ses lieux", async () => {
    const csv = (await alice.get(`/api/export/transactions.csv${PERIODE}`).expect(200)).text;
    expect(csv).toContain(";Camping;");
    expect(csv).not.toContain(";Bar;");
  });

  it("crée un lieu dont il devient le commercial, et ne peut pas l'attribuer à un autre", async () => {
    const bobId = (await prisma.user.findUniqueOrThrow({ where: { email: "bob@test.fr" } })).id;
    const res = await alice.post("/api/lieux", { raisonSociale: "N", enseigne: "Nouveau", typeLieuId: typeId, commercialId: bobId }).expect(201);
    const lieu = await prisma.lieu.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(lieu.commercialId).not.toBe(bobId);
    await alice.put(`/api/lieux/${bar}`, { raisonSociale: "B", enseigne: "Bar piraté", typeLieuId: typeId }).expect(404);
  });

  it("n'a accès ni aux bornes, ni aux imports, ni aux réglages", async () => {
    await alice.get("/api/bornes").expect(403);
    await alice.get("/api/imports/erreurs").expect(403);
    await alice.get("/api/utilisateurs").expect(403);
    await alice.post("/api/referentiel/valeurs", { categorie: "ZONE_GEO", code: "ILE", libelle: "Île" }).expect(403);
  });
});

describe("technicien", () => {
  it("gère les bornes mais ne voit pas le chiffre d'affaires", async () => {
    await tech.get("/api/bornes").expect(200);
    await tech.get("/api/imports/erreurs").expect(200);
    const lieux = (await tech.get("/api/lieux").expect(200)).body;
    expect(lieux).toHaveLength(2);
    expect(lieux[0].ca30jCents).toBeNull();
    await tech.get(`/api/stats/global${PERIODE}`).expect(403);
    await tech.post("/api/lieux", { raisonSociale: "X", enseigne: "X", typeLieuId: typeId }).expect(403);
  });
});

describe("partenaire", () => {
  it("ne voit que son lieu, en lecture", async () => {
    const lieux = (await part.get("/api/lieux").expect(200)).body;
    expect(lieux.map((l: { id: number }) => l.id)).toEqual([camping]);
    const stats = (await part.get(`/api/stats/lieux/${camping}${PERIODE}`).expect(200)).body;
    expect(stats.kpis.courant.caTtcCents).toBe(1300);
    await part.get(`/api/stats/lieux/${bar}${PERIODE}`).expect(404);
    expect((await part.get(`/api/stats/global${PERIODE}`)).body.kpis.courant.caTtcCents).toBe(1300);
    await part.put(`/api/lieux/${camping}`, { raisonSociale: "C", enseigne: "Camping", typeLieuId: typeId }).expect(403);
  });
});

describe("administration des utilisateurs", () => {
  it("ajoute un utilisateur et change son rôle", async () => {
    const u = (await admin.post("/api/utilisateurs", { email: "Zoe@Test.fr", nom: "Zoé", prenom: "", role: "TECHNICIEN" }).expect(201)).body;
    expect(u.email).toBe("zoe@test.fr");
    await en("zoe@test.fr").get("/api/bornes").expect(200);
    await admin.patch(`/api/utilisateurs/${u.id}`, { isActive: false }).expect(200);
    await en("zoe@test.fr").get("/api/bornes").expect(403);
  });

  it("exige un lieu pour un partenaire", async () => {
    const res = await admin.post("/api/utilisateurs", { email: "p@test.fr", nom: "P", prenom: "", role: "PARTENAIRE" }).expect(400);
    expect(res.body.error).toBe("VALIDATION");
  });

  it("empêche un admin de se retirer ses propres droits", async () => {
    const moi = await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.fr" } });
    const res = await admin.patch(`/api/utilisateurs/${moi.id}`, { role: "COMMERCIAL" }).expect(400);
    expect(res.body.error).toBe("AUTO_RETRAIT");
  });
});
