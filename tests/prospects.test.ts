import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { completude, estimer, precision, ressemblance, type Profil, type Reference } from "../src/prospects/score.js";
import { viderBase } from "./aide.js";

afterAll(() => prisma.$disconnect());

const base: Profil = {
  id: 0, enseigne: "", typeLieuId: 1, sousTypeId: null, standing: null, tailleCommune: null, zoneGeoId: null, saisonnalite: "ANNUEL",
  interieurExterieur: null, emplacementZoneId: null, eclairageId: null, concurrencePhoto: null, visibilite: null, capaciteAccueil: null,
  frequentationJour: null, clienteles: [], fermetureTardive: null, latitude: null, longitude: null,
};
const ref = (id: number, ca: number, p: Partial<Profil>): Reference => ({ ...base, id, enseigne: `L${id}`, ...p, caJourOuvertCents: ca, joursObserves: 100 });

describe("ressemblance", () => {
  it("ne compare que les critères renseignés des deux côtés", () => {
    expect(ressemblance({ ...base, capaciteAccueil: 500 }, { ...base, capaciteAccueil: 500 }).similarite).toBe(1);
    // Capacité ×10 : écart maximal sur ce critère (poids 1,5), type identique (poids 4) et saisonnalité (1)
    const r = ressemblance({ ...base, capaciteAccueil: 100 }, { ...base, capaciteAccueil: 1000 });
    expect(r.similarite).toBeCloseTo(1 - 1.5 / 6.5);
    expect(r.differences).toEqual(["Capacité d'accueil"]);
    expect(ressemblance(base, { ...base, typeLieuId: 2 }).communs).toEqual(["Saisonnalité"]);
  });

  it("complétude de la fiche", () => {
    const c = completude(base);
    expect(c.manquants).toContain("Capacité d'accueil");
    expect(c.manquants).not.toContain("Type de lieu");
    expect(completude({ ...base, capaciteAccueil: 800, visibilite: 4 }).taux).toBeGreaterThan(c.taux);
  });
});

describe("estimation", () => {
  // Parc : 3 campings (type 1) grands et visibles qui vendent bien, 3 bars (type 2) plus modestes
  const parc = [
    ref(1, 12000, { capaciteAccueil: 1000, visibilite: 5 }),
    ref(2, 10000, { capaciteAccueil: 800, visibilite: 4 }),
    ref(3, 6000, { capaciteAccueil: 200, visibilite: 2 }),
    ref(4, 3000, { typeLieuId: 2, capaciteAccueil: 100, visibilite: 3 }),
    ref(5, 2000, { typeLieuId: 2, capaciteAccueil: 80, visibilite: 2 }),
    ref(6, 1000, { typeLieuId: 2, capaciteAccueil: 60, visibilite: 1 }),
  ];

  it("s'appuie sur les lieux semblables, et situe l'estimation dans le parc", () => {
    const e = estimer({ ...base, id: 99, capaciteAccueil: 900, visibilite: 5 }, parc)!;
    expect(e.voisins.map((v) => v.id)).toEqual([1, 2, 3]); // les bars sont trop différents
    expect(e.caJourOuvertCents).toBeGreaterThan(9000);
    expect(e.caJourOuvertCents).toBeLessThan(12000);
    expect(e.score).toBe(67); // fait mieux que 4 lieux sur 6
    expect(e.classe).toBe("B");
    expect(estimer({ ...base, id: 98, typeLieuId: 2, capaciteAccueil: 70, visibilite: 2 }, parc)!.classe).toBe("D");
  });

  it("précision mesurée en estimant chaque lieu à partir des autres", () => {
    const p = precision(parc)!;
    expect(p.lieux).toBe(6);
    expect(p.ecartMedian).toBeLessThan(0.6);
    expect(precision(parc.slice(0, 3))).toBeNull();
  });
});

describe("routes", () => {
  const app = creerApp();
  const api = request(app);

  it("liste des prospects, périmètre du commercial et anonymisation des voisins", async () => {
    await viderBase();
    const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "CAMPING", libelle: "Camping" } });
    const gamme = await prisma.gamme.create({ data: { code: "MT", libelle: "Ma Trombine" } });
    const tm = await prisma.typeModulePaiement.create({ data: { code: "ING", libelle: "ING" } });
    const co = await prisma.user.create({ data: { email: "co@test.fr", nom: "Co", prenom: "Co", role: "COMMERCIAL" } });
    // Un lieu équipé depuis 60 jours (hors périmètre du commercial) : 100 €/jour
    const actif = await prisma.lieu.create({ data: { raisonSociale: "S", enseigne: "Camping Réf", ville: "Royan", typeLieuId: type.id, capaciteAccueil: 800 } });
    const borne = await prisma.borne.create({ data: { identifiant: "MT-1", gammeId: gamme.id, numeroSerie: "1" } });
    const hier = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 1));
    await prisma.affectationBorne.create({ data: { borneId: borne.id, lieuId: actif.id, debut: new Date(hier.getTime() - 59 * 86_400_000) } });
    await prisma.aggJour.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({ jour: new Date(hier.getTime() - i * 86_400_000), lieuId: actif.id, borneId: borne.id, typeModuleId: tm.id, moyenPaiement: "CB" as const, nbAcceptees: 10, caTtcCents: 10000 })),
    });
    const [p1, p2] = await Promise.all(
      [co.id, null].map((commercialId, i) =>
        prisma.lieu.create({ data: { raisonSociale: "S", enseigne: `Prospect ${i + 1}`, typeLieuId: type.id, statut: "PROSPECT", commercialId, capaciteAccueil: 700, horaires: { create: [] } } })
      )
    );

    const admin = (await api.get("/api/prospects").expect(200)).body;
    expect(admin.references).toBe(1);
    expect(admin.prospects).toHaveLength(2);
    expect(admin.prospects[0]).toMatchObject({ joursOuvertsAn: 365, estimation: { caJourOuvertCents: 10000, voisins: [{ id: actif.id, enseigne: "Camping Réf" }] } });
    expect(admin.prospects[0].caAnnuelCents).toBe(3650000);

    const commercial = (await api.get("/api/prospects").set("X-Dev-Utilisateur", "co@test.fr").expect(200)).body;
    expect(commercial.prospects.map((p: { id: number }) => p.id)).toEqual([p1.id]);
    expect(commercial.prospects[0].estimation.voisins[0]).toMatchObject({ id: null, enseigne: "Camping · Royan" });
    await api.get(`/api/prospects/${p2.id}`).set("X-Dev-Utilisateur", "co@test.fr").expect(404);
    await api.get(`/api/prospects/${actif.id}`).expect(404); // pas un prospect
    expect((await api.get(`/api/prospects/${p1.id}`).expect(200)).body).toMatchObject({ id: p1.id, references: 1 });
  });
});
