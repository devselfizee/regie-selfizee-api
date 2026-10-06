import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { lireCsv, lireDate, lireMontant, suggererColonnes } from "../src/rapprochement/csv.js";
import { apparier } from "../src/rapprochement/moteur.js";
import { viderBase } from "./aide.js";

const app = creerApp();
const api = request(app);

afterAll(() => prisma.$disconnect());

describe("lecture du relevé CSV", () => {
  it("montants dans tous les formats courants", () => {
    expect(lireMontant("12,50")).toBe(1250);
    expect(lireMontant("12.5")).toBe(1250);
    expect(lireMontant("1 234,56 €")).toBe(123456);
    expect(lireMontant("1.234,56")).toBe(123456);
    expect(lireMontant("1,234.56")).toBe(123456);
    expect(lireMontant("-8,00")).toBe(-800);
    expect(lireMontant("(8,00)")).toBe(-800);
    expect(lireMontant("8")).toBe(800);
    expect(lireMontant("1250", true)).toBe(1250);
    expect(lireMontant("abc")).toBeNull();
    expect(lireMontant("")).toBeNull();
  });

  it("dates en heure de Paris, sauf fuseau explicite", () => {
    expect(lireDate("15/09/2026 14:30")?.toISOString()).toBe("2026-09-15T12:30:00.000Z");
    expect(lireDate("15/09/2026", "14:30:05")?.toISOString()).toBe("2026-09-15T12:30:05.000Z");
    expect(lireDate("2026-01-15 14:30")?.toISOString()).toBe("2026-01-15T13:30:00.000Z"); // heure d'hiver
    expect(lireDate("2026-09-15T14:30:00Z")?.toISOString()).toBe("2026-09-15T14:30:00.000Z");
    expect(lireDate("31/02/2026")).toBeNull();
    expect(lireDate("n'importe quoi")).toBeNull();
  });

  it("séparateur, guillemets et colonnes devinées", () => {
    const csv = lireCsv('﻿Date;Heure;N° terminal;Montant;N° autorisation\r\n15/09/2026;14:30;T001;"8,00";A1\r\n\r\n15/09/2026;15:00;T001;4,00;A2\r\n');
    expect(csv.separateur).toBe(";");
    expect(csv.lignes).toEqual([["15/09/2026", "14:30", "T001", "8,00", "A1"], ["15/09/2026", "15:00", "T001", "4,00", "A2"]]);
    expect(suggererColonnes(csv.entetes)).toEqual({ date: 0, heure: 1, terminal: 2, montant: 3, reference: 4 });
    expect(lireCsv("a,b\n1,\"x,y\"").lignes).toEqual([["1", "x,y"]]);
  });
});

describe("appariement", () => {
  const t = (hm: string) => new Date(`2026-09-15T${hm}:00Z`);
  const l = (id: number, hm: string, montantCents: number, reference: string | null = null) => ({ id: BigInt(id), horodatage: t(hm), montantCents, reference });

  it("référence, puis montant au plus proche, puis écart de montant", () => {
    const res = apparier(
      [l(1, "10:00", 800, "A1"), l(2, "11:00", 400), l(3, "12:00", 600), l(4, "13:00", 800)],
      [l(10, "10:30", 800, "A1"), l(11, "11:04", 400), l(12, "10:58", 400), l(13, "12:01", 500), l(14, "15:00", 800)]
    );
    expect(res).toEqual([
      { ligneId: 1n, transactionId: 10n, statut: "RAPPROCHE" }, // même référence malgré 30 min d'écart
      { ligneId: 2n, transactionId: 12n, statut: "RAPPROCHE" }, // la plus proche des deux à 400
      { ligneId: 3n, transactionId: 13n, statut: "ECART" }, // 1 min d'écart, montant différent
    ]); // ligne 4 : rien à moins de 10 min → encaissée non remontée ; ventes 11 et 14 non encaissées
  });

  it("un remboursement n'est pas un écart sur une vente", () => {
    expect(apparier([l(1, "10:00", -800)], [l(10, "10:01", 800)])).toEqual([]);
    expect(apparier([l(1, "10:00", -800)], [l(10, "10:01", -800)])).toEqual([{ ligneId: 1n, transactionId: 10n, statut: "RAPPROCHE" }]);
  });
});

describe("import d'un relevé et rapprochement", () => {
  let borneId: number;
  let lieuId: number;
  let cle: string;

  beforeEach(async () => {
    await viderBase();
    const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "BAR", libelle: "Bar" } });
    lieuId = (await prisma.lieu.create({ data: { raisonSociale: "SAS", enseigne: "Bar du Port", typeLieuId: type.id } })).id;
    const gamme = await prisma.gamme.create({ data: { code: "MT", libelle: "Ma Trombine" } });
    const ing = await prisma.typeModulePaiement.create({ data: { code: "INGENICO_SELF_2000", libelle: "Ingenico" } });
    await prisma.typeModulePaiement.create({ data: { code: "MONNAYEUR", libelle: "Monnayeur" } });
    const b = (await api.post("/api/bornes").send({ identifiant: "MT-0042", gammeId: gamme.id, numeroSerie: "S1", module: { typeId: ing.id, numeroSerie: "SELF-1" } }).expect(201)).body;
    borneId = b.id;
    cle = b.cleApi;
    // Le TID est saisi après coup sur la fiche borne
    const modules = (await api.put(`/api/bornes/${borneId}/module`).send({ typeId: ing.id, numeroSerie: "SELF-1", identifiantPrestataire: "T001" }).expect(200)).body;
    expect(modules).toHaveLength(1);
    expect(modules[0].identifiantPrestataire).toBe("T001");
    await prisma.affectationBorne.create({ data: { borneId, lieuId, debut: new Date("2026-09-01T00:00:00Z") } });

    const vente = (id: string, heure: string, euros: number, extra: object = {}) => ({
      transaction_id: id, horodatage: `2026-09-15T${heure}:00+02:00`, montant_ttc_centimes: euros * 100, devise: "EUR", statut: "accepte",
      module: { type: "INGENICO_SELF_2000", numero_serie: "SELF-1" }, moyen_paiement: "sans_contact", produit: { code: "BANDE_4", nb_tirages: 2 }, ...extra,
    });
    await api.post("/ingest/v1/transactions").set("Authorization", `Bearer ${cle}`).send({
      schema_version: "1.0", borne_id: "MT-0042", envoye_le: "2026-09-15T23:00:00+02:00", logiciel_version: "3.4.1",
      transactions: [
        vente("V1", "14:30", 8, { reference_monetique: "A1" }),
        vente("V2", "15:00", 4),
        vente("V3", "16:00", 6), // le relevé dit 5 € : écart
        vente("V4", "18:00", 8), // absente du relevé : remontée non encaissée
        vente("E1", "17:00", 5, { module: { type: "MONNAYEUR" }, moyen_paiement: "especes" }), // espèces : hors relevé
      ],
    }).expect(200);
  });

  const CSV = [
    "Date;Heure;Terminal;Montant;Autorisation",
    "15/09/2026;14:31;T001;8,00;A1",
    "15/09/2026;15:02;T001;4,00;",
    "15/09/2026;16:00;T001;5,00;",
    "15/09/2026;17:30;T001;12,00;", // encaissée, jamais remontée
    "15/09/2026;17:45;T999;3,00;", // terminal inconnu
    "pas une date;;T001;1,00;",
  ].join("\n");
  const colonnes = { date: 0, heure: 1, terminal: 2, montant: 3, reference: 4 };
  const importer = () => api.post("/api/rapprochement/releves").send({ fournisseur: "Ingenico", fichierNom: "releve.csv", contenu: CSV, colonnes });

  it("aperçu : colonnes devinées", async () => {
    const res = await api.post("/api/rapprochement/apercu").send({ contenu: CSV }).expect(200);
    expect(res.body.colonnes).toEqual(colonnes);
    expect(res.body.nbLignes).toBe(6);
  });

  it("rapproche, signale les écarts dans les deux sens et lève une alerte", async () => {
    const res = await importer().expect(201);
    expect(res.body.import).toMatchObject({ lignes: 5, doublons: 0, rejetees: 1, alertes: 1 });
    expect(res.body.import.erreurs[0]).toMatchObject({ ligne: 7 });
    expect(res.body.synthese).toMatchObject({
      lignes: 5, montantCents: 3200, rapprochees: 2, ecarts: 1, ecartCents: -100,
      nonRemontees: 1, nonRemonteesCents: 1200, nonEncaissees: 1, nonEncaisseesCents: 800,
      terminauxInconnus: [{ terminal: "T999", lignes: 1, montantCents: 300 }],
    });
    expect(res.body.ecarts[0]).toMatchObject({ montantCents: 500, vente: { montantCents: 600, transactionId: "V3" } });
    expect(res.body.nonEncaissees[0]).toMatchObject({ transactionId: "V4", lieu: { enseigne: "Bar du Port" } });

    const statuts = await prisma.transaction.findMany({ orderBy: { transactionIdModule: "asc" }, select: { transactionIdModule: true, rapprochement: true } });
    expect(Object.fromEntries(statuts.map((s) => [s.transactionIdModule, s.rapprochement]))).toEqual({
      E1: "NON_APPLICABLE", V1: "RAPPROCHE", V2: "RAPPROCHE", V3: "ECART", V4: "NON_RAPPROCHE",
    });
    const alerte = await prisma.alerte.findFirstOrThrow({ where: { type: "ECART_RAPPROCHEMENT" } });
    expect(alerte).toMatchObject({ borneId, lieuId });
    expect(alerte.message).toContain("1 paiement(s) encaissé(s) non remonté(s)");

    // Liste des relevés
    const liste = (await api.get("/api/rapprochement/releves").expect(200)).body;
    expect(liste[0]).toMatchObject({ lignes: 5, rapprochees: 2, ecarts: 1, nonRapprochees: 2, periodeDebut: "2026-09-15" });

    // Export des anomalies
    const xlsx = await api.get(`/api/rapprochement/releves/${res.body.releve.id}/anomalies.xlsx`).buffer(true)
      .parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); }).expect(200);
    const classeur = new ExcelJS.Workbook();
    await classeur.xlsx.load(xlsx.body);
    const types = classeur.worksheets[0].getColumn(1).values.slice(2);
    expect(types).toEqual(["Écart de montant", "Encaissé non remonté", "Remonté non encaissé"]);
  });

  it("ne réimporte pas deux fois le même fichier", async () => {
    await importer().expect(201);
    expect((await importer().expect(409)).body.error).toBe("RELEVE_DEJA_IMPORTE");
  });

  it("relance après une vente reçue en retard, et suppression", async () => {
    const id = (await importer().expect(201)).body.releve.id;
    await api.post("/ingest/v1/transactions").set("Authorization", `Bearer ${cle}`).send({
      schema_version: "1.0", borne_id: "MT-0042", envoye_le: "2026-09-16T10:00:00+02:00", logiciel_version: "3.4.1",
      transactions: [{ transaction_id: "V5", horodatage: "2026-09-15T17:29:00+02:00", montant_ttc_centimes: 1200, devise: "EUR", statut: "accepte",
        module: { type: "INGENICO_SELF_2000" }, moyen_paiement: "cb", produit: { code: "BANDE_4", nb_tirages: 2 } }],
    }).expect(200);
    const relance = (await api.post(`/api/rapprochement/releves/${id}/relancer`).expect(200)).body;
    expect(relance.nouveaux).toBe(1);
    expect(relance.synthese).toMatchObject({ rapprochees: 3, nonRemontees: 0 });

    await api.delete(`/api/rapprochement/releves/${id}`).expect(204);
    expect(await prisma.transaction.count({ where: { rapprochement: { in: ["RAPPROCHE", "ECART"] } } })).toBe(0);
    expect(await prisma.releveLigne.count()).toBe(0);
  });
});
