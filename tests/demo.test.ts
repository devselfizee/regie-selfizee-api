import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { initialiserReferentiel } from "../src/referentiel/initial.js";
import { viderBase } from "./aide.js";

// Données de démonstration : l'effacement ne doit jamais toucher une vraie donnée
const app = creerApp();
const api = request(app);
afterAll(() => prisma.$disconnect());

let vraiLieu: number;
let vraieBorne: number;

beforeEach(async () => {
  await viderBase();
  await initialiserReferentiel();
  // De vraies données, qui doivent survivre à l'effacement de la démo
  const bar = await prisma.refValeur.findFirstOrThrow({ where: { categorie: "TYPE_LIEU", code: "BAR" } });
  vraiLieu = (await prisma.lieu.create({ data: { raisonSociale: "Vrai SAS", enseigne: "Vrai bar", typeLieuId: bar.id } })).id;
  const b = (await api.post("/api/bornes").send({ identifiant: "S513", gammeId: (await prisma.gamme.findUniqueOrThrow({ where: { code: "SPHERIK" } })).id, numeroSerie: "SPHERIK-513" }).expect(201)).body;
  vraieBorne = b.id;
  await prisma.affectationBorne.create({ data: { borneId: vraieBorne, lieuId: vraiLieu, debut: new Date("2026-01-01T00:00:00Z") } });
  await api.post("/ingest/v1/transactions").set("Authorization", `Bearer ${b.cleApi}`).send({
    schema_version: "1.1", borne_id: "S513", envoye_le: "2026-10-01T12:00:00+02:00", logiciel_version: "1",
    transactions: [{ transaction_id: "S513-1", horodatage: "2026-10-01T11:00:00+02:00", montant_ttc_centimes: 800, devise: "EUR", statut: "accepte",
      module: { type: "HEXAPAY" }, moyen_paiement: "cb", produit: { code: "TIRAGE", nb_tirages: 2 } }],
  }).expect(200);
});

const vraiesDonnees = async () => ({
  lieu: await prisma.lieu.count({ where: { id: vraiLieu } }),
  borne: await prisma.borne.count({ where: { id: vraieBorne } }),
  ventes: await prisma.transaction.count({ where: { borneId: vraieBorne } }),
  ca: (await prisma.aggJour.aggregate({ where: { lieuId: vraiLieu }, _sum: { caTtcCents: true } }))._sum.caTtcCents,
});

describe("données de démonstration", () => {
  it("création complète, puis effacement sans toucher aux vraies données", async () => {
    const avant = await vraiesDonnees();
    const cree = (await api.post("/api/demo").expect(201)).body;
    expect(cree).toMatchObject({ present: true, lieux: 5, bornes: 5 });
    expect(cree.ventesCreees).toBeGreaterThan(1000);
    await api.post("/api/demo").expect(409); // déjà présentes

    // Tout ce qui fait vivre l'application est là
    const lieuxDemo = await prisma.lieu.findMany({ where: { demo: true }, select: { id: true, enseigne: true, statut: true } });
    expect(lieuxDemo.every((l) => l.enseigne.startsWith("[DÉMO] "))).toBe(true);
    expect(lieuxDemo.filter((l) => l.statut === "PROSPECT")).toHaveLength(1);
    const L = lieuxDemo.map((l) => l.id);
    expect(await prisma.contratCommission.count({ where: { lieuId: { in: L } } })).toBe(4);
    expect(await prisma.reversement.count({ where: { lieuId: { in: L } } })).toBeGreaterThan(0);
    expect(await prisma.evenementLieu.count({ where: { lieuId: { in: L } } })).toBe(2);
    expect(await prisma.transaction.count({ where: { statut: "OFFERTE" } })).toBeGreaterThan(0);
    expect(await prisma.transaction.count({ where: { moyenPaiement: "WEB" } })).toBeGreaterThan(0);
    expect(await prisma.heartbeat.count()).toBeGreaterThan(1000);

    const efface = (await api.delete("/api/demo").expect(200)).body;
    expect(efface).toMatchObject({ lieux: 5, bornes: 5, ventes: cree.ventes });
    expect((await api.get("/api/demo").expect(200)).body).toEqual({ present: false, lieux: 0, bornes: 0, ventes: 0 });
    expect(await prisma.contratCommission.count()).toBe(0);
    expect(await prisma.heartbeat.count({ where: { borneId: { not: vraieBorne } } })).toBe(0);
    expect(await vraiesDonnees()).toEqual(avant);
    expect(await prisma.auditLog.count({ where: { entite: "demo" } })).toBe(2);
  });

  it("refuse d'effacer si une vraie borne est mêlée à un lieu de démo", async () => {
    await api.post("/api/demo").expect(201);
    const lieuDemo = await prisma.lieu.findFirstOrThrow({ where: { demo: true, statut: "ACTIF" } });
    await prisma.affectationBorne.updateMany({ where: { borneId: vraieBorne }, data: { fin: new Date("2026-02-01T00:00:00Z") } });
    await prisma.affectationBorne.create({ data: { borneId: vraieBorne, lieuId: lieuDemo.id, debut: new Date("2026-02-01T00:00:00Z") } });

    const r = await api.delete("/api/demo").expect(409);
    expect(r.body.error).toBe("DEMO_MELANGEE");
    expect(r.body.message).toContain("S513");
    expect((await api.get("/api/demo").expect(200)).body.present).toBe(true); // rien d'effacé
  });

  it("réservé à l'admin", async () => {
    await prisma.user.create({ data: { email: "co@test.fr", nom: "C", prenom: "C", role: "COMMERCIAL" } });
    await api.get("/api/demo").set("X-Dev-Utilisateur", "co@test.fr").expect(403);
    await api.delete("/api/demo").set("X-Dev-Utilisateur", "co@test.fr").expect(403);
  });
});
