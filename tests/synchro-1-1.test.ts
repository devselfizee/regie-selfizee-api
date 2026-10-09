import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { recalculerAgregats } from "../src/ingestion/agregats.js";
import { exemple, viderBase } from "./aide.js";

// Avenant « synchronisation des ventes » du 07/10/2026 : schéma 1.1
const app = creerApp();
const api = request(app);
afterAll(() => prisma.$disconnect());

let cle: string;
let borneId: number;
let lieuId: number;

beforeEach(async () => {
  await viderBase();
  const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "BAR", libelle: "Bar" } });
  lieuId = (await prisma.lieu.create({ data: { raisonSociale: "SAS", enseigne: "Le Club", typeLieuId: type.id } })).id;
  const gamme = await prisma.gamme.create({ data: { code: "SPHERIK", libelle: "Spherik" } });
  const hexapay = await prisma.typeModulePaiement.create({ data: { code: "HEXAPAY", libelle: "Hexapay", rapprochable: true } });
  await prisma.typeModulePaiement.create({ data: { code: "STRIPE_QR", libelle: "QR", rapprochable: false } });
  await prisma.typeModulePaiement.create({ data: { code: "INGENICO_SELF_2000", libelle: "Ingenico", rapprochable: true } });
  await prisma.typeModulePaiement.create({ data: { code: "MONNAYEUR", libelle: "Monnayeur" } });
  const b = (await api.post("/api/bornes").send({ identifiant: "S513", gammeId: gamme.id, numeroSerie: "SPHERIK-513", module: { typeId: hexapay.id } }).expect(201)).body;
  cle = b.cleApi;
  borneId = b.id;
  await prisma.affectationBorne.create({ data: { borneId, lieuId, debut: new Date("2026-09-01T00:00:00Z") } });
});

const vente = (rang: number, extra: Record<string, unknown> = {}) => ({
  transaction_id: `S513-20261005-K7PX2M-${rang}`,
  horodatage: `2026-10-05T22:${String(10 + rang).padStart(2, "0")}:00+02:00`,
  montant_ttc_centimes: 800,
  devise: "EUR",
  statut: "accepte",
  module: { type: "HEXAPAY" },
  moyen_paiement: "sans_contact",
  produit: { code: "TIRAGE", libelle: "2 tirages", nb_tirages: 2 },
  ...extra,
});
const envoyer = (transactions: unknown[], version = "1.1") =>
  api.post("/ingest/v1/transactions").set("Authorization", `Bearer ${cle}`).send({
    schema_version: version, borne_id: "S513", envoye_le: "2026-10-05T23:30:00+02:00", logiciel_version: "piktoo-2026.10", transactions,
  });

describe("schéma 1.1 : ventes vues de la borne", () => {
  it("tous les cas de l'avenant, et les agrégats qui en découlent", async () => {
    const r = await envoyer([
      vente(1, { encaissement: "confirme", reference_monetique: "554821", reference_sequence: "000184", pikcloud_uuid: "0f8c1c2e-5b7a-4c1e-9d2a-3f4b5c6d7e8f" }),
      vente(2, { encaissement: "incertain" }), // compté, mais à vérifier
      vente(3, { statut: "refuse", motif: "banque", moyen_paiement: "cb", produit: { code: "TIRAGE", nb_tirages: 0 } }),
      vente(4, { statut: "annule", motif: "invite", moyen_paiement: "autre", produit: { code: "TIRAGE", nb_tirages: 0 } }),
      vente(5, { statut: "expire", motif: "terminal", moyen_paiement: "autre", produit: { code: "TIRAGE", nb_tirages: 0 } }),
      vente(6, { statut: "offert" }), // imprimé, jamais débité
      vente(7, { module: { type: "STRIPE_QR" }, moyen_paiement: "web", reference_monetique: "pi_3Q0abc", montant_ttc_centimes: 1200, encaissement: "confirme" }),
      vente(8, { produit: { code: "NUMERIQUE", libelle: "Photo numérique", nb_tirages: 0 }, montant_ttc_centimes: 500 }),
      vente(9, { montant_ttc_centimes: 0, moyen_paiement: "aucun", gratuite: "code_staff", produit: { code: "TIRAGE", nb_tirages: 1 } }),
      vente(10, { produit: { code: "TIRAGE_EXTRA", libelle: "+1 pour un pote", nb_tirages: 1 }, montant_ttc_centimes: 400 }),
    ]).expect(200);
    expect(r.body).toMatchObject({ recues: 10, creees: 10, rejetees: 0 });

    const agg = await prisma.aggJour.aggregate({
      where: { lieuId },
      _sum: {
        nbAcceptees: true, caTtcCents: true, nbRefusees: true, nbAnnulees: true, nbExpirees: true, nbOffertes: true, nbGratuites: true,
        nbTirages: true, tiragesNonFactures: true, nbIncertaines: true, caIncertainTtcCents: true,
      },
    });
    expect(agg._sum).toEqual({
      nbAcceptees: 5, // 1, 2, 7, 8, 10 : ventes payées
      caTtcCents: 800 + 800 + 1200 + 500 + 400,
      nbRefusees: 1, nbAnnulees: 1, nbExpirees: 1, nbOffertes: 1, nbGratuites: 1,
      nbTirages: 2 + 2 + 2 + 0 + 1,
      tiragesNonFactures: 2 + 1, // offerte + gratuite
      nbIncertaines: 1, caIncertainTtcCents: 800,
    });

    // Rapprochement : QR Stripe et gratuité hors relevé de terminal
    const t = Object.fromEntries((await prisma.transaction.findMany()).map((x) => [x.transactionIdModule.slice(-2).replace("-", ""), x]));
    expect(t["1"]).toMatchObject({ encaissement: "CONFIRME", referenceMonetique: "554821", referenceSequence: "000184", rapprochement: "NON_RAPPROCHE" });
    expect(t["7"]).toMatchObject({ moyenPaiement: "WEB", rapprochement: "NON_APPLICABLE" });
    expect(t["9"]).toMatchObject({ moyenPaiement: "AUCUN", gratuite: "CODE_STAFF", rapprochement: "NON_APPLICABLE" });
    expect(t["5"]).toMatchObject({ statut: "EXPIREE", motif: "TERMINAL" });

    // Le recalcul complet donne les mêmes agrégats que l'ingestion incrémentale
    const avant = await prisma.aggJour.findMany({ where: { lieuId }, orderBy: [{ typeModuleId: "asc" }, { moyenPaiement: "asc" }] });
    await recalculerAgregats(borneId, new Date("2026-10-05T00:00:00Z"), new Date("2026-10-05T00:00:00Z"));
    const apres = await prisma.aggJour.findMany({ where: { lieuId }, orderBy: [{ typeModuleId: "asc" }, { moyenPaiement: "asc" }] });
    const sansDate = (x: typeof avant) => x.map(({ majLe: _m, ...r }) => r);
    expect(sansDate(apres)).toEqual(sansDate(avant));

    // Indicateurs : l'expiration n'entre pas dans le taux de refus
    const s = (await api.get(`/api/stats/lieux/${lieuId}?du=2026-10-05&au=2026-10-05`).expect(200)).body.kpis.courant;
    expect(s).toMatchObject({ nbVentes: 5, nbRefusees: 1, nbExpirees: 1, nbOffertes: 1, nbGratuites: 1, tiragesNonFactures: 3, nbIncertaines: 1, caIncertainTtcCents: 800 });
    expect(s.tauxRefus).toBeCloseTo(1 / 6);
  });

  it("règles de cohérence, ligne par ligne", async () => {
    const r = await envoyer([
      vente(1, { gratuite: "degrade" }), // gratuité avec un moyen de paiement
      vente(2, { moyen_paiement: "aucun" }), // « aucun » à 8 €
      vente(3, { statut: "refuse", encaissement: "confirme" }), // encaissement sur un refus
      vente(4, { moyen_paiement: "aucun", montant_ttc_centimes: 0, reference_monetique: "123456" }),
      vente(5, { numero_carte: "4970…" }), // jamais de donnée carte
      vente(6),
    ]).expect(200);
    expect(r.body).toMatchObject({ creees: 1, rejetees: 5 });
    expect(r.body.erreurs.map((e: { code: string }) => e.code)).toEqual(Array(5).fill("SCHEMA_INVALIDE"));
  });

  it("les lots 1.0 restent acceptés", async () => {
    const lot = exemple("transactions.ok.json");
    lot.borne_id = "S513";
    lot.transactions = lot.transactions.map((t: { module: { type: string } }) => ({ ...t, module: { ...t.module, type: t.module.type === "MONNAYEUR" ? "MONNAYEUR" : "INGENICO_SELF_2000" } }));
    await api.post("/ingest/v1/transactions").set("Authorization", `Bearer ${cle}`).send(lot).expect(200);
    expect(await prisma.transaction.count()).toBe(4);
  });

  it("heartbeat 1.1 : sans ruban, codes d'erreur libres", async () => {
    await api.post("/ingest/v1/heartbeats").set("Authorization", `Bearer ${cle}`).send({
      schema_version: "1.1",
      borne_id: "S513",
      heartbeats: [{
        horodatage: "2026-10-05T22:00:00+02:00", logiciel_version: "piktoo-2026.10", papier_restant: 180,
        erreurs: [{ code: "TPE_MUET", composant: "module_paiement" }, { code: "CODE_PAS_ENCORE_PUBLIE", composant: "autre" }],
      }],
    }).expect(200);
  });
});

describe("remboursement saisi en back-office", () => {
  it("partiel puis solde, rattaché à la vente et au lieu", async () => {
    await envoyer([vente(1, { reference_monetique: "554821" })]).expect(200);
    const [v] = (await api.get("/api/ventes?q=554821").expect(200)).body;
    expect(v).toMatchObject({ transactionIdModule: "S513-20261005-K7PX2M-1", rembourseCents: 0, lieu: { enseigne: "Le Club" } });

    await api.post(`/api/ventes/${v.id}/remboursement`).send({ montantCents: 300, motif: "Tirage raté" }).expect(201);
    await api.post(`/api/ventes/${v.id}/remboursement`).send({ montantCents: 600, motif: "Trop" }).expect(400);
    const solde = await api.post(`/api/ventes/${v.id}/remboursement`).send({ motif: "Solde" }).expect(201);
    expect(solde.body).toMatchObject({ transactionId: "S513-20261005-K7PX2M-1-RMB2", montantCents: 500 });
    await api.post(`/api/ventes/${v.id}/remboursement`).send({ motif: "Encore" }).expect(400);

    const agg = await prisma.aggJour.aggregate({ where: { lieuId }, _sum: { nbRemboursees: true, rembourseTtcCents: true, caTtcCents: true } });
    expect(agg._sum).toEqual({ nbRemboursees: 2, rembourseTtcCents: 800, caTtcCents: 800 });
    expect((await api.get("/api/ventes?q=K7PX2M-1").expect(200)).body.find((x: { id: string }) => x.id === v.id).rembourseCents).toBe(800);
    expect(await prisma.auditLog.count({ where: { action: "REMBOURSEMENT" } })).toBe(2);

    await prisma.user.create({ data: { email: "co@test.fr", nom: "C", prenom: "C", role: "COMMERCIAL" } });
    await api.get("/api/ventes").set("X-Dev-Utilisateur", "co@test.fr").expect(403);
  });
});
