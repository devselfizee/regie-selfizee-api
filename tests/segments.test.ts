import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { fermetureLaPlusTardive, joursEffectifs, mediane, minutesOuverture, tranchesFermeture } from "../src/stats/segments.js";
import { viderBase } from "./aide.js";

const app = creerApp();
const api = request(app);
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const heure = (h: string) => new Date(`1970-01-01T${h}:00Z`);
const annuel = { saisonnalite: "ANNUEL" as const, saisons: [], fermetures: [] };

afterAll(() => prisma.$disconnect());

describe("calculs", () => {
  it("compte les heures d'un créneau de nuit et repère la fermeture la plus tardive", () => {
    const boite = { ...annuel, horaires: [{ jourSemaine: 5, ouverture: heure("23:00"), fermeture: heure("05:00") }] };
    expect(minutesOuverture(boite, d("2026-10-09"))).toBe(6 * 60); // vendredi
    expect(minutesOuverture(boite, d("2026-10-10"))).toBe(0); // samedi : pas de créneau qui commence
    expect(fermetureLaPlusTardive(boite)).toBe(29);
    expect(tranchesFermeture(29)).toBe("Après 2 h");
    expect(tranchesFermeture(22)).toBe("20 h – 23 h");
  });

  it("un lieu saisonnier sans saison saisie est considéré ouvert", () => {
    const saisonnierIncomplet = { saisonnalite: "SAISONNIER" as const, saisons: [], fermetures: [], horaires: [] };
    expect(minutesOuverture(saisonnierIncomplet, d("2026-12-01"))).toBe(12 * 60);
    const avecSaison = { ...saisonnierIncomplet, saisons: [{ debut: d("2026-04-01"), fin: d("2026-09-30") }] };
    expect(minutesOuverture(avecSaison, d("2026-12-01"))).toBe(0);
  });

  it("ne compte que les jours ouverts où une borne était installée", () => {
    const l = { ...annuel, horaires: [] };
    const eff = joursEffectifs(l, [{ debut: d("2026-09-06"), fin: null }], d("2026-09-01"), d("2026-09-10"));
    expect(eff).toEqual({ jours: 5, minutes: 5 * 12 * 60 });
  });

  it("médiane", () => {
    expect(mediane([300, 100, 100])).toBe(100);
    expect(mediane([1, 2, 3, 4])).toBe(2.5);
    expect(mediane([])).toBeNull();
  });
});

describe("GET /api/stats/segments", () => {
  let ids: Record<string, number>;

  beforeEach(async () => {
    await viderBase();
    const ref = async (categorie: "TYPE_LIEU" | "ZONE_GEO" | "CLIENTELE", code: string, ordre = 0) =>
      (await prisma.refValeur.create({ data: { categorie, code, libelle: code.charAt(0) + code.slice(1).toLowerCase(), ordre } })).id;
    const bar = await ref("TYPE_LIEU", "BAR", 2);
    const camping = await ref("TYPE_LIEU", "CAMPING", 1);
    const urbaine = await ref("ZONE_GEO", "URBAINE");
    const littoral = await ref("ZONE_GEO", "LITTORAL");
    const familles = await ref("CLIENTELE", "FAMILLES");
    const etudiants = await ref("CLIENTELE", "ETUDIANTS");
    const alice = await prisma.user.create({ data: { email: "alice@t.fr", nom: "Martin", prenom: "Alice", role: "COMMERCIAL" } });

    const gamme = await prisma.gamme.create({ data: { code: "MT", libelle: "MT" } });
    const tm = await prisma.typeModulePaiement.create({ data: { code: "ING", libelle: "ING" } });
    ids = {};
    let n = 0;
    // CA total sur la période (10 jours du 1er au 10 septembre), début d'affectation
    const lieux: [string, number, number, number | null, string, number[], number | undefined][] = [
      ["A", bar, urbaine, 100000, "2026-01-01", [etudiants], alice.id],
      ["B", bar, urbaine, 300000, "2026-01-01", [etudiants, familles], undefined],
      ["C", camping, littoral, 50000, "2026-01-01", [familles], undefined],
      ["D", bar, littoral, 50000, "2026-09-06", [], undefined], // équipé le 6 : 5 jours effectifs
      ["E", bar, urbaine, null, "", [], undefined], // jamais équipé : écarté
    ];
    for (const [nom, typeLieuId, zoneGeoId, ca, debut, clienteles, commercialId] of lieux) {
      const lieu = await prisma.lieu.create({
        data: {
          raisonSociale: nom, enseigne: `Lieu ${nom}`, typeLieuId, zoneGeoId, commercialId, capaciteAccueil: 100, frequentationJour: 500,
          clienteles: { create: clienteles.map((refValeurId) => ({ refValeurId })) },
        },
      });
      ids[nom] = lieu.id;
      if (!debut) continue;
      const borne = await prisma.borne.create({ data: { identifiant: `B-${++n}`, gammeId: gamme.id, numeroSerie: `${n}` } });
      await prisma.affectationBorne.create({ data: { borneId: borne.id, lieuId: lieu.id, debut: d(debut) } });
      await prisma.aggJour.create({
        data: { jour: d("2026-09-08"), lieuId: lieu.id, borneId: borne.id, typeModuleId: tm.id, moyenPaiement: "CB", nbAcceptees: 1, caTtcCents: ca!, caHtCents: 0 },
      });
    }
  });

  const PERIODE = "du=2026-09-01&au=2026-09-10";

  it("donne moyenne, médiane et nombre de lieux par type, CA par jour d'ouverture effectif", async () => {
    const r = (await api.get(`/api/stats/segments?${PERIODE}&x=typeLieu`).expect(200)).body;
    expect(r.x.valeurs).toEqual(["Camping", "Bar"]); // ordre de la liste administrable
    const barre = r.cases.find((c: { x: string }) => c.x === "Bar").stats.caJourOuvert;
    // A : 1 000 € / 10 j = 100 € ; B : 300 € ; D : 500 € / 5 j = 100 € (pas pénalisé)
    expect(barre).toEqual({ n: 3, moyenne: (10000 + 30000 + 10000) / 3, mediane: 10000 });
    expect(r.exclus).toEqual(["Lieu E"]);
    const a = r.lieux.find((l: { enseigne: string }) => l.enseigne === "Lieu A");
    expect(a).toMatchObject({ joursEffectifs: 10, caJourOuvert: 10000, caHeureOuverture: 10000 / 12, caParPlace: 100, caParVisiteur: 20 });
  });

  it("croise deux critères ; un lieu à plusieurs clientèles compte dans chacune", async () => {
    const r = (await api.get(`/api/stats/segments?${PERIODE}&x=typeLieu&y=zoneGeo`).expect(200)).body;
    const cle = (x: string, y: string) => r.cases.find((c: { x: string; y: string }) => c.x === x && c.y === y)?.stats.caJourOuvert.n;
    expect([cle("Bar", "Urbaine"), cle("Bar", "Littoral"), cle("Camping", "Littoral")]).toEqual([2, 1, 1]);

    const cl = (await api.get(`/api/stats/segments?${PERIODE}&x=clientele`).expect(200)).body;
    const n = (x: string) => cl.cases.find((c: { x: string }) => c.x === x).stats.ca.n;
    expect([n("Etudiants"), n("Familles"), n("Non renseigné")]).toEqual([2, 2, 1]);
    expect(cl.x.valeurs.at(-1)).toBe("Non renseigné");
  });

  it("le commercial n'analyse que ses lieux ; un critère inconnu est refusé", async () => {
    const r = (await api.get(`/api/stats/segments?${PERIODE}&x=typeLieu`).set("X-Dev-Utilisateur", "alice@t.fr").expect(200)).body;
    expect(r.lieux.map((l: { enseigne: string }) => l.enseigne)).toEqual(["Lieu A"]);
    await api.get(`/api/stats/segments?${PERIODE}&x=inexistant`).expect(400);
  });
});
