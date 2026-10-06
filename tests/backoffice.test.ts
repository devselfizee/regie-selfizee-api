import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import ExcelJS from "exceljs";
import { exemple, viderBase } from "./aide.js";

const app = creerApp();
const api = request(app);

let ref: { camping: number; bar: number; familles: number; gamme: number; ingenico: number };

afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await viderBase();
  const [camping, bar, familles] = await Promise.all([
    prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "CAMPING", libelle: "Camping" } }),
    prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "BAR", libelle: "Bar" } }),
    prisma.refValeur.create({ data: { categorie: "CLIENTELE", code: "FAMILLES", libelle: "Familles" } }),
  ]);
  const gamme = await prisma.gamme.create({ data: { code: "MA_TROMBINE", libelle: "Ma Trombine" } });
  const ingenico = await prisma.typeModulePaiement.create({ data: { code: "INGENICO_SELF_2000", libelle: "Ingenico Self 2000" } });
  await prisma.typeModulePaiement.create({ data: { code: "MONNAYEUR", libelle: "Monnayeur" } });
  ref = { camping: camping.id, bar: bar.id, familles: familles.id, gamme: gamme.id, ingenico: ingenico.id };
});

const creerLieu = async (enseigne: string, typeLieuId: number) =>
  (await api.post("/api/lieux").send({ raisonSociale: `${enseigne} SAS`, enseigne, typeLieuId }).expect(201)).body.id as number;

const creerBorne = async (identifiant = "MT-0042") =>
  (
    await api
      .post("/api/bornes")
      .send({ identifiant, gammeId: ref.gamme, numeroSerie: `S-${identifiant}`, module: { typeId: ref.ingenico, numeroSerie: `TPE-${identifiant}` } })
      .expect(201)
  ).body as { id: number; cleApi: string };

const envoyerVentes = (cle: string, lot = exemple("transactions.ok.json")) =>
  api.post("/ingest/v1/transactions").set("Authorization", `Bearer ${cle}`).send(lot).expect(200);

const caLieu = async (lieuId: number) =>
  (await prisma.aggJour.aggregate({ where: { lieuId }, _sum: { caTtcCents: true } }))._sum.caTtcCents ?? 0;

describe("fiche lieu", () => {
  it("crée et relit une fiche complète", async () => {
    const res = await api
      .post("/api/lieux")
      .send({
        raisonSociale: "SARL Flots Bleus",
        enseigne: "Camping Les Flots Bleus",
        siret: "12345678900012",
        typeLieuId: ref.camping,
        saisonnalite: "SAISONNIER",
        capaciteAccueil: 1200,
        visibilite: 4,
        dateSignature: "2026-03-01",
        clienteleIds: [ref.familles],
        contacts: [{ role: "GERANT", nom: "Martin", email: "gerant@exemple.fr" }],
        horaires: [{ jourSemaine: 6, ouverture: "10:00", fermeture: "02:00" }],
        saisons: [{ libelle: "Été 2026", debut: "2026-04-01", fin: "2026-09-30" }],
      })
      .expect(201);

    const fiche = (await api.get(`/api/lieux/${res.body.id}`).expect(200)).body;
    expect(fiche.typeLieu.libelle).toBe("Camping");
    expect(fiche.clienteles.map((c: { code: string }) => c.code)).toEqual(["FAMILLES"]);
    expect(fiche.horaires[0]).toMatchObject({ jourSemaine: 6, ouverture: "10:00", fermeture: "02:00" });
    expect(fiche.contacts[0].nom).toBe("Martin");
    expect(fiche.dateSignature.slice(0, 10)).toBe("2026-03-01");
  });

  it("remplace les sous-listes à la modification", async () => {
    const id = await creerLieu("Bar du Port", ref.bar);
    const base = { raisonSociale: "Bar du Port SAS", enseigne: "Bar du Port", typeLieuId: ref.bar };
    await api.put(`/api/lieux/${id}`).send({ ...base, horaires: [{ jourSemaine: 1, ouverture: "18:00", fermeture: "01:00" }] }).expect(200);
    await api.put(`/api/lieux/${id}`).send({ ...base, horaires: [{ jourSemaine: 5, ouverture: "19:00", fermeture: "03:00" }] }).expect(200);
    const fiche = (await api.get(`/api/lieux/${id}`)).body;
    expect(fiche.horaires).toHaveLength(1);
    expect(fiche.horaires[0].jourSemaine).toBe(5);
  });

  it("refuse une fiche invalide avec le détail des champs", async () => {
    const res = await api.post("/api/lieux").send({ enseigne: "X", typeLieuId: ref.camping, visibilite: 9 }).expect(400);
    expect(res.body.champs.map((c: { chemin: string }) => c.chemin).sort()).toEqual(["raisonSociale", "visibilite"]);
  });
});

describe("bornes et affectations", () => {
  it("crée une borne avec sa clé, sans jamais renvoyer le hash", async () => {
    const borne = await creerBorne();
    expect(borne.cleApi).toMatch(/^rgs_/);
    const liste = (await api.get("/api/bornes").expect(200)).body;
    expect(liste[0]).not.toHaveProperty("apiKeyHash");
    expect(liste[0].cleConfiguree).toBe(true);
    expect(liste[0].modules[0].type.code).toBe("INGENICO_SELF_2000");
  });

  it("rattache les ventes reçues avant l'affectation, et résout l'alerte", async () => {
    const borne = await creerBorne();
    const camping = await creerLieu("Camping", ref.camping);

    const r = await envoyerVentes(borne.cleApi);
    expect(r.body.non_affectees).toBe(4);
    expect(await prisma.alerte.count({ where: { statut: "NOUVELLE" } })).toBe(1);

    await api.post("/api/affectations").send({ borneId: borne.id, lieuId: camping, debut: "2026-04-01T00:00:00+02:00" }).expect(201);

    expect(await prisma.transaction.count({ where: { lieuId: camping } })).toBe(4);
    expect(await caLieu(camping)).toBe(1300);
    expect((await prisma.alerte.findFirstOrThrow()).statut).toBe("RESOLUE");
  });

  it("déplace une borne : clôture l'affectation en cours et répartit les ventes par date", async () => {
    const borne = await creerBorne();
    const camping = await creerLieu("Camping", ref.camping);
    const bar = await creerLieu("Bar", ref.bar);
    await api.post("/api/affectations").send({ borneId: borne.id, lieuId: camping, debut: "2026-04-01T00:00:00+02:00" }).expect(201);
    await envoyerVentes(borne.cleApi);

    // Déplacement saisi après coup, à 23h le 5 octobre
    await api.post("/api/affectations").send({ borneId: borne.id, lieuId: bar, debut: "2026-10-05T23:00:00+02:00" }).expect(201);

    const affectations = await prisma.affectationBorne.findMany({ orderBy: { debut: "asc" } });
    expect(affectations[0].fin?.toISOString()).toBe("2026-10-05T21:00:00.000Z");
    expect(await caLieu(camping)).toBe(1300); // vente 22h47 (8 €) + espèces 22h58 (5 €)
    expect(await prisma.transaction.count({ where: { lieuId: bar } })).toBe(1); // remboursement 23h05
    expect((await prisma.aggJour.aggregate({ where: { lieuId: bar }, _sum: { rembourseTtcCents: true } }))._sum.rembourseTtcCents).toBe(800);
  });

  it("refuse deux affectations qui se chevauchent", async () => {
    const borne = await creerBorne();
    const camping = await creerLieu("Camping", ref.camping);
    const bar = await creerLieu("Bar", ref.bar);
    await api.post("/api/affectations").send({ borneId: borne.id, lieuId: camping, debut: "2026-04-01T00:00:00+02:00", fin: "2026-09-30T00:00:00+02:00" }).expect(201);
    const res = await api.post("/api/affectations").send({ borneId: borne.id, lieuId: bar, debut: "2026-06-01T00:00:00+02:00", fin: "2026-07-01T00:00:00+02:00" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("CHEVAUCHEMENT");
  });

  it("supprimer une affectation détache ses ventes", async () => {
    const borne = await creerBorne();
    const camping = await creerLieu("Camping", ref.camping);
    const a = (await api.post("/api/affectations").send({ borneId: borne.id, lieuId: camping, debut: "2026-04-01T00:00:00+02:00" })).body;
    await envoyerVentes(borne.cleApi);
    await api.delete(`/api/affectations/${a.id}`).expect(204);
    expect(await prisma.transaction.count({ where: { lieuId: null } })).toBe(4);
    expect(await prisma.aggJour.count()).toBe(0);
  });
});

describe("statistiques", () => {
  let camping: number;
  let bar: number;

  beforeEach(async () => {
    const borne = await creerBorne();
    await creerBorne("MT-0043"); // affectée au bar, sans vente
    camping = await creerLieu("Camping", ref.camping);
    bar = await creerLieu("Bar", ref.bar);
    const b43 = await prisma.borne.findUniqueOrThrow({ where: { identifiant: "MT-0043" } });
    await api.post("/api/affectations").send({ borneId: borne.id, lieuId: camping, debut: "2026-04-01T00:00:00+02:00" }).expect(201);
    await api.post("/api/affectations").send({ borneId: b43.id, lieuId: bar, debut: "2026-04-01T00:00:00+02:00" }).expect(201);
    await envoyerVentes(borne.cleApi);
  });

  it("vue globale : KPI, série, classement et parc", async () => {
    const res = await api.get("/api/stats/global?du=2026-10-01&au=2026-10-31").expect(200);
    const { kpis, serie, classement, parc } = res.body;

    expect(kpis.courant).toMatchObject({ caTtcCents: 1300, nbVentes: 2, panierMoyenCents: 650, nbRefusees: 1, rembourseTtcCents: 800 });
    expect(kpis.courant.tauxRefus).toBeCloseTo(1 / 3);
    expect(kpis.n1).toMatchObject({ du: "2025-10-01", au: "2025-10-31", caTtcCents: 0 });
    expect(kpis.precedente).toMatchObject({ du: "2026-08-31", au: "2026-09-30" });
    expect(serie).toEqual([{ periode: "2026-10-05", caTtcCents: 1300, nbVentes: 2 }]);
    expect(classement.map((c: { enseigne: string; caTtcCents: number }) => [c.enseigne, c.caTtcCents])).toEqual([
      ["Camping", 1300],
      ["Bar", 0],
    ]);
    expect(parc).toMatchObject({ bornesAffectees: 2, actives: 1, bornesNonAffectees: 0 });
    expect(parc.inactives[0].identifiant).toBe("MT-0043");
  });

  it("filtre par champ de la fiche lieu et par moyen de paiement", async () => {
    const parType = (await api.get(`/api/stats/global?du=2026-10-01&au=2026-10-31&typeLieuId=${ref.bar}`)).body;
    expect(parType.kpis.courant.caTtcCents).toBe(0);
    expect(parType.classement).toHaveLength(1);

    const especes = (await api.get("/api/stats/global?du=2026-10-01&au=2026-10-31&moyenPaiement=ESPECES")).body;
    expect(especes.kpis.courant.caTtcCents).toBe(500);
  });

  it("agrège par mois", async () => {
    const res = await api.get("/api/stats/global?du=2026-01-01&au=2026-12-31&granularite=mois").expect(200);
    expect(res.body.serie).toEqual([{ periode: "2026-10-01", caTtcCents: 1300, nbVentes: 2 }]);
  });

  it("vue par lieu : heatmap, jours, formules, moyens, bornes", async () => {
    const res = await api.get(`/api/stats/lieux/${camping}?du=2026-10-01&au=2026-10-31`).expect(200);
    const s = res.body;
    expect(s.heatmap).toEqual([{ jourSemaine: 1, heure: 22, nbVentes: 2, caTtcCents: 1300 }]); // lundi 22h
    expect(s.joursSemaine[0]).toMatchObject({ jourSemaine: 1, caTtcCents: 1300, joursAvecVente: 1 });
    expect(s.joursSemaine[0].caMoyenCents).toBe(325); // 4 lundis en octobre 2026
    expect(s.formules.map((f: { code: string }) => f.code).sort()).toEqual(["BANDE_4", "PHOTO_ID"]);
    expect(s.moyensPaiement.find((m: { moyen: string }) => m.moyen === "CB").nbRefusees).toBe(1);
    expect(s.meilleuresDates[0]).toEqual({ jour: "2026-10-05", caTtcCents: 1300, nbVentes: 2 });
    expect(s.bornes.map((b: { identifiant: string }) => b.identifiant)).toEqual(["MT-0042"]);
  });

  it("exporte les ventes et le classement au format Excel (.xlsx)", async () => {
    const binaire = (r: request.Test) =>
      r.buffer(true).parse((res, cb) => {
        const m: Buffer[] = [];
        res.on("data", (x: Buffer) => m.push(x));
        res.on("end", () => cb(null, Buffer.concat(m)));
      });
    const lire = async (url: string) => {
      const res = await binaire(api.get(url)).expect(200);
      expect(res.headers["content-type"]).toContain("spreadsheetml");
      const classeur = new ExcelJS.Workbook();
      await classeur.xlsx.load(res.body as unknown as ArrayBuffer);
      return classeur.worksheets[0];
    };

    const ventes = await lire("/api/export/transactions.xlsx?du=2026-10-01&au=2026-10-31");
    expect(ventes.rowCount).toBe(5); // en-tête + 4 transactions
    const premiere = ventes.getRow(2);
    expect(premiere.getCell(2).value).toBe("Camping");
    expect(premiere.getCell(9).value).toBe(8); // montant TTC : un vrai nombre
    expect(premiere.getCell(1).value).toBeInstanceOf(Date); // une vraie date Excel
    expect((premiere.getCell(1).value as Date).toISOString()).toBe("2026-10-05T22:47:31.000Z"); // 22 h 47, heure de Paris

    const classement = await lire("/api/export/classement.xlsx?du=2026-10-01&au=2026-10-31");
    const l = classement.getRow(2);
    expect([1, 2, 4, 5, 6, 7, 8].map((c) => l.getCell(c).value)).toEqual([1, "Camping", "Camping", 13, 2, 1, 13]);
  });

  it("laisse le front lire le nom du fichier exporté (CORS)", async () => {
    const res = await api.get("/api/export/classement.csv?du=2026-10-01&au=2026-10-31").set("Origin", "http://localhost:3000").expect(200);
    expect(res.headers["access-control-expose-headers"]).toContain("Content-Disposition");
  });

  it("exporte les transactions en CSV lisible par Excel", async () => {
    const res = await api.get("/api/export/transactions.csv?du=2026-10-01&au=2026-10-31").expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lignes = res.text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lignes).toHaveLength(5); // en-tête + 4 transactions
    expect(lignes[1]).toContain("05/10/2026;22:47:31;Camping;");
    expect(lignes[1]).toContain(";8,00;6,67;");
  });
});
