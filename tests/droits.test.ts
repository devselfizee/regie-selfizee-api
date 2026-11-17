import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { genererCle } from "../src/lib/cleBorne.js";
import { exemple, viderBase } from "./aide.js";

// Sans Keycloak (tests), X-Dev-Utilisateur désigne l'utilisateur connecté et X-Dev-Droits simule ses droits Konitys
// (« * » = admin de la plateforme ; sinon les clés accordées, contrôle d'accès actif). Profils d'après
// docs/droits-correspondance-roles.md, commercial limité à ses lieux (sans lieux.view_any).
const app = creerApp();
const DROITS = {
  admin: "*",
  commercial: "app.access,pages.lieux.view,lieux.view_own,lieux.create,lieux.edit,ventes.view,ventes.export",
  technicien: "app.access,pages.lieux.view,pages.bornes.view,lieux.view_own,lieux.view_any,bornes.view,bornes.edit,imports.manage,supervision.view",
  partenaire: "app.access,lieux.view_own,ventes.view,ventes.export",
};
const en = (email: string, droits = DROITS.admin) => {
  const r = (req: request.Test) => req.set("X-Dev-Utilisateur", email).set("X-Dev-Droits", droits);
  return {
    get: (url: string) => r(request(app).get(url)),
    post: (url: string, body: object) => r(request(app).post(url)).send(body),
    put: (url: string, body: object) => r(request(app).put(url)).send(body),
    patch: (url: string, body: object) => r(request(app).patch(url)).send(body),
    delete: (url: string) => r(request(app).delete(url)),
  };
};
const admin = en("admin@test.fr");
const alice = en("alice@test.fr", DROITS.commercial); // commerciale du camping
const tech = en("tech@test.fr", DROITS.technicien);
const part = en("camping@test.fr", DROITS.partenaire); // partenaire : le camping

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
    prisma.user.create({ data: { email: "alice@test.fr", nom: "Martin", prenom: "Alice" } }),
    prisma.user.create({ data: { email: "bob@test.fr", nom: "Durand", prenom: "Bob" } }),
    prisma.user.create({ data: { email: "admin@test.fr", nom: "Admin", prenom: "" } }),
    prisma.user.create({ data: { email: "tech@test.fr", nom: "Tech", prenom: "" } }),
    prisma.user.create({ data: { email: "inactif@test.fr", nom: "Ancien", prenom: "", isActive: false } }),
  ]);
  camping = (await prisma.lieu.create({ data: { raisonSociale: "C", enseigne: "Camping", typeLieuId: typeId, commercialId: a.id } })).id;
  bar = (await prisma.lieu.create({ data: { raisonSociale: "B", enseigne: "Bar", typeLieuId: typeId, commercialId: b.id } })).id;
  await prisma.user.create({ data: { email: "camping@test.fr", nom: "Gérant", prenom: "", accesLieux: { create: { lieuId: camping } } } });

  // Des ventes au camping et au bar
  const gamme = await prisma.gamme.create({ data: { code: "MT", libelle: "Ma Trombine" } });
  await prisma.typeModulePaiement.create({ data: { code: "INGENICO_SELF_2000", libelle: "Ingenico" } });
  await prisma.typeModulePaiement.create({ data: { code: "MONNAYEUR", libelle: "Monnayeur" } });
  for (const [id, lieuId] of [["MT-0042", camping], ["MT-0043", bar]] as const) {
    const k = genererCle();
    const borne = await prisma.borne.create({
      data: { identifiant: id, gammeId: gamme.id, apiKeyHash: k.hash, apiKeyPrefix: k.prefixe },
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
    expect(moi).toMatchObject({ email: "alice@test.fr" });
  });
});

describe("commercial limité à ses lieux (lieux.view_own sans lieux.view_any)", () => {
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

  it("crée un lieu dont il devient le commercial, sans pouvoir l'attribuer à un autre (lieux.commercial_edit)", async () => {
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

describe("technicien (bornes, sans ventes.view)", () => {
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

describe("partenaire (son lieu, en lecture)", () => {
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

describe("client : un ou plusieurs lieux (demande du 17/11)", () => {
  it("voit ses lieux et leur chiffre, pas les autres ; la liste se règle dans Utilisateurs", async () => {
    const gerant = await prisma.user.findUniqueOrThrow({ where: { email: "camping@test.fr" } });
    await admin.patch(`/api/utilisateurs/${gerant.id}`, { lieuIds: [camping, bar] }).expect(200);
    const lieux = (await part.get("/api/lieux").expect(200)).body;
    expect(lieux.map((l: { id: number }) => l.id).sort()).toEqual([camping, bar].sort());
    expect((await part.get(`/api/stats/global${PERIODE}`)).body.kpis.courant.caTtcCents).toBe(2600);
    expect((await part.get(`/api/stats/global${PERIODE}&lieuId=${bar}`)).body.kpis.courant.caTtcCents).toBe(1300);
    const moi = (await part.get("/api/utilisateurs/moi").expect(200)).body;
    expect(moi.lieux.map((l: { enseigne: string }) => l.enseigne)).toEqual(["Bar", "Camping"]);
    // La liste envoyée remplace l'ancienne ; un lieu inconnu est refusé
    await admin.patch(`/api/utilisateurs/${gerant.id}`, { lieuIds: [bar] }).expect(200);
    await part.get(`/api/lieux/${camping}`).expect(404);
    await part.get(`/api/lieux/${bar}`).expect(200);
    await admin.patch(`/api/utilisateurs/${gerant.id}`, { lieuIds: [999_999] }).expect(400);
  });
});

describe("apporteur d'affaires (demande du 17/11)", () => {
  it("touche un % des ventes de ses lieux, mois par mois, et ne voit rien d'autre", async () => {
    const ami = await prisma.user.create({ data: { email: "ami@test.fr", nom: "Ami", prenom: "" } });
    const apporteur = en("ami@test.fr", "app.access,pages.mes_apports.view,apporteurs.view_own");
    await apporteur.get("/api/apporteurs").expect(403);
    await apporteur.get(`/api/stats/global${PERIODE}`).expect(403);
    expect((await apporteur.get("/api/lieux").expect(200)).body).toEqual([]);

    const regle = (await admin.post("/api/apporteurs/regles", { userId: ami.id, lieuId: camping, tauxBp: 1000, dateDebut: "2026-10-01" }).expect(201)).body;
    expect(regle.taux).toBe("10 %");
    await admin.post("/api/apporteurs/regles", { userId: ami.id, lieuId: camping, tauxBp: 500, dateDebut: "2026-10-01" }).expect(409);
    await admin.post("/api/apporteurs/regles", { userId: 999_999, lieuId: camping, tauxBp: 500, dateDebut: "2026-10-01" }).expect(400);

    // Octobre 2026 : 1 300 € de ventes au camping → 130 € de commission ; le bar n'y est pas
    const mes = (await apporteur.get("/api/apporteurs/moi").expect(200)).body;
    expect(mes.lieux.map((l: { enseigne: string }) => l.enseigne)).toEqual(["Camping"]);
    expect(mes.mois.find((m: { mois: string }) => m.mois === "2026-10")).toMatchObject({ baseCents: 1300, commissionCents: 130, nbVentes: 2 });
    expect(mes.totaux.nbLieux).toBe(1);

    const liste = (await admin.get("/api/apporteurs").expect(200)).body;
    expect(liste).toHaveLength(1);
    expect(liste[0].apporteur.email).toBe("ami@test.fr");
    expect(liste[0].regles).toHaveLength(1);
    expect((await admin.get(`/api/apporteurs/${ami.id}/tableau`).expect(200)).body.totaux.totalCents).toBe(130);

    await admin.patch(`/api/apporteurs/regles/${regle.id}`, { tauxBp: 2000 }).expect(200);
    expect((await apporteur.get("/api/apporteurs/moi")).body.mois.find((m: { mois: string }) => m.mois === "2026-10").commissionCents).toBe(260);
    await alice.delete(`/api/apporteurs/regles/${regle.id}`).expect(403);
    await admin.delete(`/api/apporteurs/regles/${regle.id}`).expect(204);
    expect((await apporteur.get("/api/apporteurs/moi")).body.lieux).toEqual([]);
  });
});

describe("administration des utilisateurs", () => {
  it("ajoute un utilisateur, puis le désactive", async () => {
    const u = (await admin.post("/api/utilisateurs", { email: "Zoe@Test.fr" }).expect(201)).body;
    expect(u.email).toBe("zoe@test.fr");
    await en("zoe@test.fr", DROITS.technicien).get("/api/bornes").expect(200);
    await admin.patch(`/api/utilisateurs/${u.id}`, { isActive: false }).expect(200);
    await en("zoe@test.fr", DROITS.technicien).get("/api/bornes").expect(403);
  });

  it("refuse sans le droit utilisateurs.manage", async () => {
    await alice.post("/api/utilisateurs", { email: "x@test.fr" }).expect(403);
  });

  it("empêche de désactiver son propre compte", async () => {
    const moi = await prisma.user.findUniqueOrThrow({ where: { email: "admin@test.fr" } });
    const res = await admin.patch(`/api/utilisateurs/${moi.id}`, { isActive: false }).expect(400);
    expect(res.body.error).toBe("AUTO_RETRAIT");
  });
});
