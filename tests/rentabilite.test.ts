import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { calculerReversements } from "../src/commissions/service.js";
import { amortissement, retourInvestissement } from "../src/rentabilite/calcul.js";
import { viderBase } from "./aide.js";

const app = creerApp();
const api = request(app);
const d = (s: string) => new Date(`${s}T00:00:00Z`);

afterAll(() => prisma.$disconnect());

describe("amortissement", () => {
  it("linéaire au jour sur la durée, nul ensuite", () => {
    const borne = { coutAchatCents: 120000, dureeAmortissementMois: 12, dateMiseEnService: d("2026-01-01") };
    expect(amortissement(borne, d("2026-01-01"), d("2026-01-31"))).toBeCloseTo((120000 * 31) / 365);
    expect(amortissement(borne, d("2026-01-01"), d("2026-12-31"))).toBeCloseTo(120000);
    expect(amortissement(borne, d("2027-01-01"), d("2027-01-31"))).toBe(0);
    expect(amortissement({ ...borne, coutAchatCents: null }, d("2026-01-01"), d("2026-01-31"))).toBe(0);
  });
});

describe("rentabilité par borne", () => {
  let lieuId: number;
  let a: number;
  let b: number;

  beforeEach(async () => {
    await viderBase();
    const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "BAR", libelle: "Bar" } });
    lieuId = (await prisma.lieu.create({ data: { raisonSociale: "SAS", enseigne: "Bar du Port", typeLieuId: type.id } })).id;
    const gamme = await prisma.gamme.create({ data: { code: "MT", libelle: "Ma Trombine" } });
    const tm = await prisma.typeModulePaiement.create({ data: { code: "ING", libelle: "ING" } });
    a = (await prisma.borne.create({ data: { identifiant: "MT-A", gammeId: gamme.id, numeroSerie: "A", statut: "INSTALLEE" } })).id;
    b = (await prisma.borne.create({ data: { identifiant: "MT-B", gammeId: gamme.id, numeroSerie: "B", statut: "INSTALLEE" } })).id;
    for (const borneId of [a, b]) {
      await prisma.affectationBorne.create({ data: { borneId, lieuId, debut: d("2026-09-01") } });
    }
    // Chaque mois de septembre à novembre : A vend 600 € TTC (500 € HT), B 300 € TTC (250 € HT)
    for (const mois of ["2026-09-15", "2026-10-15", "2026-11-15"]) {
      await prisma.aggJour.createMany({
        data: [
          { jour: d(mois), lieuId, borneId: a, typeModuleId: tm.id, moyenPaiement: "CB", nbAcceptees: 60, caTtcCents: 60000, caHtCents: 50000 },
          { jour: d(mois), lieuId, borneId: b, typeModuleId: tm.id, moyenPaiement: "CB", nbAcceptees: 30, caTtcCents: 30000, caHtCents: 25000 },
        ],
      });
    }
    // Contrat : 10 % du CA TTC du lieu → 90 €/mois, dont 60 € attribuables à A (2/3 du CA)
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send({ modele: "POURCENTAGE", tauxBp: 1000, periodicite: "MOIS", dateEffet: "2026-09-01" }).expect(201);
    await calculerReversements({ lieuId, jusquA: d("2026-11-30") });

    // Septembre : 20 € de consommables et une intervention à 35 €
    await api.post(`/api/bornes/${a}/couts`).send({ date: "2026-09-10", categorie: "CONSOMMABLES", montantCents: 2000, libelle: "Papier" }).expect(201);
    await api.post(`/api/bornes/${a}/interventions`).send({ date: "2026-09-20T10:00:00+02:00", motif: "Bourrage imprimante", coutCents: 3500 }).expect(201);
    // Achat 1 200 €, amorti sur 12 mois à partir du 1er septembre
    await api.patch(`/api/rentabilite/bornes/${a}/achat`).send({ coutAchatCents: 120000, dureeAmortissementMois: 12, dateMiseEnService: "2026-09-01" }).expect(200);
  });

  it("calcule la marge nette : CA HT − part des commissions − coûts − amortissement", async () => {
    const r = (await api.get(`/api/rentabilite/bornes/${a}?du=2026-09-01&au=2026-09-30`).expect(200)).body.rentabilite;
    const amort = Math.round((120000 * 30) / 365);
    expect(r).toMatchObject({ caHtCents: 50000, commissionsCents: 6000, coutsCents: 5500, amortissementCents: amort });
    expect(r.coutsParCategorie).toEqual({ CONSOMMABLES: 2000, INTERVENTION: 3500 });
    expect(r.margeNetteCents).toBe(50000 - 6000 - 5500 - amort);
  });

  it("répartit la commission du lieu entre ses bornes au prorata de leur CA", async () => {
    const liste = (await api.get("/api/rentabilite?du=2026-09-01&au=2026-11-30").expect(200)).body;
    const parBorne = Object.fromEntries(liste.bornes.map((x: { identifiant: string; commissionsCents: number }) => [x.identifiant, x.commissionsCents]));
    expect(parBorne).toEqual({ "MT-A": 18000, "MT-B": 9000 }); // 3 mois × (60 € ; 30 €) = les 270 € versés au lieu
    expect(liste.total.commissionsCents).toBe(27000);
  });

  it("donne la date de retour sur investissement", async () => {
    // Marge avant amortissement : sept. 385 €, oct. 440 €, nov. 440 € → 1 265 € ≥ 1 200 € en novembre
    const roi = (await retourInvestissement(a, d("2026-12-15")))!;
    expect(roi.mois.map((m) => m.margeCents)).toEqual([38500, 44000, 44000, 0]);
    expect(roi.dateRetour).toBe("2026-11-30");
    expect(roi.partRemboursee).toBe(1);

    // Au 31 octobre : 825 € remboursés, rythme de 385 € (seul mois complet) → encore 1 mois
    const enCours = (await retourInvestissement(a, d("2026-10-31")))!;
    expect(enCours.dateRetour).toBeNull();
    expect(enCours.moisRestants).toBe(1);
    expect(await retourInvestissement(b, d("2026-12-15"))).toBeNull(); // pas de prix d'achat
  });

  it("le technicien saisit coûts et interventions, sans voir la rentabilité", async () => {
    await prisma.user.create({ data: { email: "tech@t.fr", nom: "T", prenom: "", role: "TECHNICIEN" } });
    const tech = (r: request.Test) => r.set("X-Dev-Utilisateur", "tech@t.fr");
    const i = (await tech(api.post(`/api/bornes/${b}/interventions`)).send({ date: "2026-10-02T09:00:00+02:00", motif: "Nettoyage" }).expect(201)).body;
    const technicien = await prisma.user.findUniqueOrThrow({ where: { email: "tech@t.fr" } });
    expect(i.technicienId).toBe(technicien.id);
    await tech(api.post(`/api/bornes/${b}/couts`)).send({ date: "2026-10-02", categorie: "DEPLACEMENT", montantCents: 4000 }).expect(201);
    await tech(api.get("/api/rentabilite")).expect(403);
    await tech(api.patch(`/api/rentabilite/bornes/${b}/achat`)).send({ coutAchatCents: 1, dureeAmortissementMois: 1, dateMiseEnService: null }).expect(403);
  });

  it("place les interventions sur la courbe du lieu", async () => {
    const s = (await api.get(`/api/stats/lieux/${lieuId}?du=2026-09-01&au=2026-09-30`).expect(200)).body;
    expect(s.interventions).toEqual([{ jour: "2026-09-20", motif: "Bourrage imprimante", borne: "MT-A" }]);
  });

  it("modifier le coût d'une intervention remplace le coût enregistré ; la supprimer le retire", async () => {
    const [i] = (await api.get(`/api/bornes/${a}/interventions`).expect(200)).body;
    expect(i.coutCents).toBe(3500);
    await api.patch(`/api/interventions/${i.id}`).send({ coutCents: 5000, resolueLe: "2026-09-20T12:00:00+02:00" }).expect(200);
    expect((await api.get(`/api/bornes/${a}/interventions`)).body[0].coutCents).toBe(5000);
    await api.delete(`/api/interventions/${i.id}`).expect(204);
    expect(await prisma.coutBorne.count({ where: { categorie: "INTERVENTION" } })).toBe(0);
  });
});
