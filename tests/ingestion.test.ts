import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { genererCle } from "../src/lib/cleBorne.js";
import { recalculerAgregats } from "../src/ingestion/agregats.js";
import { exemple, viderBase } from "./aide.js";

const app = creerApp();
let cle: string;
let borneId: number;
let lieuId: number;

const envoyer = (body: object, k = cle) =>
  request(app).post("/ingest/v1/transactions").set("Authorization", `Bearer ${k}`).send(body);

afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await viderBase();
  const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "CAMPING", libelle: "Camping" } });
  const gamme = await prisma.gamme.create({ data: { code: "MA_TROMBINE", libelle: "Ma Trombine" } });
  await prisma.typeModulePaiement.createMany({
    data: [
      { code: "INGENICO_SELF_2000", libelle: "Ingenico Self 2000" },
      { code: "MONNAYEUR", libelle: "Monnayeur" },
    ],
  });
  const lieu = await prisma.lieu.create({
    data: { raisonSociale: "SARL Test", enseigne: "Camping test", typeLieuId: type.id },
  });
  const k = genererCle();
  const borne = await prisma.borne.create({
    data: {
      identifiant: "MT-0042", gammeId: gamme.id, numeroSerie: "S-42", statut: "INSTALLEE",
      apiKeyHash: k.hash, apiKeyPrefix: k.prefixe,
    },
  });
  await prisma.affectationBorne.create({
    data: { borneId: borne.id, lieuId: lieu.id, debut: new Date("2026-04-01T00:00:00+02:00") },
  });
  cle = k.cle;
  borneId = borne.id;
  lieuId = lieu.id;
});

describe("POST /ingest/v1/transactions", () => {
  it("intègre un lot et alimente les agrégats", async () => {
    const res = await envoyer(exemple("transactions.ok.json"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recues: 4, creees: 4, doublons: 0, rejetees: 0, non_affectees: 0 });

    const tx = await prisma.transaction.findMany({ orderBy: { id: "asc" } });
    expect(tx.every((t) => t.lieuId === lieuId)).toBe(true);
    expect(tx[0].horodatage.toISOString()).toBe("2026-10-05T20:47:31.000Z"); // stocké en UTC
    expect(tx[0].offsetMinutes).toBe(120);
    expect(tx[0].montantHtCents).toBe(667);
    expect(tx[3].transactionOrigineId).toBe(tx[0].id); // remboursement lié à la vente

    const agg = await prisma.aggJour.findMany({ where: { lieuId } });
    const total = (k: "caTtcCents" | "nbAcceptees" | "nbRefusees" | "rembourseTtcCents") =>
      agg.reduce((s, a) => s + a[k], 0);
    expect(total("caTtcCents")).toBe(1300); // 8 € sans contact + 5 € espèces
    expect(total("nbAcceptees")).toBe(2);
    expect(total("nbRefusees")).toBe(1);
    expect(total("rembourseTtcCents")).toBe(800);

    const heures = await prisma.aggHeure.findMany({ orderBy: { heure: "asc" } });
    expect(heures.map((h) => h.heure)).toEqual([22]); // heure de Paris
  });

  it("est idempotent : renvoyer le même lot ne change rien", async () => {
    await envoyer(exemple("transactions.ok.json"));
    const aggAvant = await prisma.aggJour.findMany({ orderBy: { moyenPaiement: "asc" } });

    const res = await envoyer(exemple("transactions.ok.json"));
    expect(res.body).toMatchObject({ creees: 0, doublons: 4, rejetees: 0 });
    expect(await prisma.transaction.count()).toBe(4);

    const aggApres = await prisma.aggJour.findMany({ orderBy: { moyenPaiement: "asc" } });
    expect(aggApres.map(({ majLe, ...a }) => a)).toEqual(aggAvant.map(({ majLe, ...a }) => a));
  });

  it("n'écrase jamais une transaction renvoyée avec un contenu différent", async () => {
    await envoyer(exemple("transactions.ok.json"));
    const lot = exemple("transactions.ok.json");
    lot.transactions = [{ ...lot.transactions[0], montant_ttc_centimes: 99900 }];

    const res = await envoyer(lot);
    expect(res.body).toMatchObject({ creees: 0, rejetees: 1 });
    expect(res.body.erreurs[0].code).toBe("CONFLIT_DOUBLON");
    const t = await prisma.transaction.findFirstOrThrow({ where: { transactionIdModule: "ING-20261005-000184" } });
    expect(t.montantTtcCents).toBe(800);
    expect(await prisma.importErreur.count({ where: { code: "CONFLIT_DOUBLON" } })).toBe(1);
  });

  it("rejette seulement les lignes invalides et garde les autres", async () => {
    const lot = exemple("transactions.ok.json");
    lot.transactions[1].pan = "4970********1234"; // donnée carte interdite
    lot.transactions[2].module.type = "INCONNU";

    const res = await envoyer(lot);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ creees: 2, rejetees: 2 });
    expect(res.body.erreurs.map((e: { code: string }) => e.code).sort()).toEqual(["MODULE_INCONNU", "SCHEMA_INVALIDE"]);
    expect((await prisma.importLot.findFirstOrThrow()).statut).toBe("PARTIEL");
  });

  it("rejette tout le lot si l'enveloppe est invalide, et le trace", async () => {
    const res = await envoyer({ ...exemple("transactions.ok.json"), transactions: [] });
    expect(res.status).toBe(400);
    expect(await prisma.transaction.count()).toBe(0);
    const lot = await prisma.importLot.findFirstOrThrow({ include: { erreurs: true } });
    expect(lot.statut).toBe("REJETE");
    expect(lot.erreurs[0].code).toBe("SCHEMA_INVALIDE");
  });

  it("rejette une vente datée dans le futur (horloge de borne déréglée)", async () => {
    const lot = exemple("transactions.ok.json");
    const demain = new Date(Date.now() + 26 * 3_600_000).toISOString().replace("Z", "+00:00").replace(/.d+/, "");
    lot.transactions = [{ ...lot.transactions[0], horodatage: demain }, lot.transactions[2]];
    const res = await envoyer(lot);
    expect(res.body).toMatchObject({ creees: 1, rejetees: 1 });
    expect(res.body.erreurs[0].code).toBe("HORODATAGE_FUTUR");
  });

  it("gère un même transaction_id deux fois dans le lot", async () => {
    const lot = exemple("transactions.ok.json");
    const [a] = lot.transactions;
    lot.transactions = [a, { ...a }, { ...a, montant_ttc_centimes: 1 }];
    const res = await envoyer(lot);
    expect(res.body).toMatchObject({ creees: 1, doublons: 1, rejetees: 1 });
    expect(res.body.erreurs[0].code).toBe("CONFLIT_DOUBLON");
  });

  it("intègre un rattrapage de 500 ventes rapidement et sans erreur de comptage", async () => {
    const lot = exemple("transactions.ok.json");
    const modele = lot.transactions[0];
    lot.rattrapage = true;
    lot.transactions = Array.from({ length: 500 }, (_, i) => ({
      ...modele,
      transaction_id: `R-${i}`,
      horodatage: new Date(Date.UTC(2026, 8, 1 + (i % 28), 8 + (i % 12), i % 60)).toISOString().replace(/.d+Z/, "Z"),
      montant_ttc_centimes: 600,
    }));
    const debut = Date.now();
    const res = await envoyer(lot);
    const duree = Date.now() - debut;
    expect(res.body).toMatchObject({ creees: 500, rejetees: 0 });
    const agg = await prisma.aggJour.aggregate({ _sum: { caTtcCents: true, nbAcceptees: true } });
    expect(agg._sum).toEqual({ caTtcCents: 300000, nbAcceptees: 500 });
    expect((await prisma.aggHeure.aggregate({ _sum: { nbAcceptees: true } }))._sum.nbAcceptees).toBe(500);
    console.log(`Rattrapage de 500 ventes : ${duree} ms`);
    expect(duree).toBeLessThan(10_000);
  });

  it("refuse une clé invalide ou une clé d'une autre borne", async () => {
    const k = genererCle().cle;
    expect((await envoyer(exemple("transactions.ok.json"), k)).status).toBe(401);
    expect((await envoyer({ ...exemple("transactions.ok.json"), borne_id: "MT-9999" })).status).toBe(403);
    expect(await prisma.transaction.count()).toBe(0);
    expect(await prisma.importErreur.count()).toBe(2);
  });

  it("stocke et signale une vente faite hors affectation, sans l'agréger", async () => {
    const lot = exemple("transactions.ok.json");
    lot.transactions = [{ ...lot.transactions[0], horodatage: "2026-03-15T15:00:00+01:00" }];

    const res = await envoyer(lot);
    expect(res.body).toMatchObject({ creees: 1, non_affectees: 1 });
    expect((await prisma.transaction.findFirstOrThrow()).lieuId).toBeNull();
    expect(await prisma.aggJour.count()).toBe(0);
    const alerte = await prisma.alerte.findFirstOrThrow();
    expect(alerte.type).toBe("BORNE_NON_AFFECTEE");

    await envoyer(lot); // pas de seconde alerte
    expect(await prisma.alerte.count()).toBe(1);
  });

  it("attribue les ventes au bon lieu selon la date d'affectation", async () => {
    const type = await prisma.refValeur.findFirstOrThrow();
    const bar = await prisma.lieu.create({ data: { raisonSociale: "Bar SAS", enseigne: "Bar d'hiver", typeLieuId: type.id } });
    const bascule = new Date("2026-10-05T21:00:00Z"); // 23h à Paris
    await prisma.affectationBorne.updateMany({ where: { borneId }, data: { fin: bascule } });
    await prisma.affectationBorne.create({ data: { borneId, lieuId: bar.id, debut: bascule } });

    await envoyer(exemple("transactions.ok.json"));
    const tx = await prisma.transaction.findMany({ orderBy: { horodatage: "asc" } });
    // 22h47, 22h51, 22h58 → camping ; 23h05 → bar
    expect(tx.map((t) => t.lieuId)).toEqual([lieuId, lieuId, lieuId, bar.id]);
  });

  it("le recalcul complet des agrégats donne le même résultat que l'incrémental", async () => {
    await envoyer(exemple("transactions.ok.json"));
    const incremental = await prisma.aggJour.findMany({ orderBy: { moyenPaiement: "asc" } });
    const heuresInc = await prisma.aggHeure.findMany();

    await recalculerAgregats(borneId, new Date("2026-10-01"), new Date("2026-10-31"));
    const recalcule = await prisma.aggJour.findMany({ orderBy: { moyenPaiement: "asc" } });
    expect(recalcule.map(({ majLe, ...a }) => a)).toEqual(incremental.map(({ majLe, ...a }) => a));
    expect(await prisma.aggHeure.findMany()).toEqual(heuresInc);
  });
});

describe("POST /ingest/v1/heartbeats", () => {
  it("enregistre les heartbeats et ignore les renvois", async () => {
    const hb = exemple("heartbeat.ok.json");
    // Dates passées : un heartbeat daté dans le futur ne met pas à jour dernier_heartbeat
    hb.heartbeats[0].horodatage = "2026-09-01T10:00:00+02:00";
    hb.heartbeats[1].horodatage = "2026-09-01T10:05:00+02:00";
    const post = () => request(app).post("/ingest/v1/heartbeats").set("Authorization", `Bearer ${cle}`).send(hb);

    expect((await post()).body).toEqual({ recus: 2, crees: 2, doublons: 0 });
    expect((await post()).body).toEqual({ recus: 2, crees: 0, doublons: 2 });

    const borne = await prisma.borne.findUniqueOrThrow({ where: { id: borneId } });
    expect(borne.dernierHeartbeat?.toISOString()).toBe("2026-09-01T08:05:00.000Z");
  });
});
