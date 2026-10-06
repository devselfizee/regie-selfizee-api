import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { viderBase } from "./aide.js";

const app = creerApp();
const api = request(app);
let typeId: number;

/** Faux géocodeur : quelques adresses connues, le reste introuvable. */
function geocodeurFactice(enPanne = false) {
  const appels: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      appels.push(url);
      if (enPanne) throw new Error("réseau");
      const q = new URL(url).searchParams.get("q") ?? "";
      const connues: Record<string, [number, number]> = {
        Nantes: [-1.5536, 47.2184],
        "La Baule": [-2.3904, 47.2865],
      };
      const ville = Object.keys(connues).find((v) => q.includes(v));
      const features = ville ? [{ geometry: { coordinates: connues[ville] }, properties: { label: ville, score: 0.9 } }] : [];
      return new Response(JSON.stringify({ features }), { status: 200 });
    })
  );
  return appels;
}

afterAll(() => prisma.$disconnect());
afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await viderBase();
  typeId = (await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "BAR", libelle: "Bar" } })).id;
});

const creer = (corps: object) => api.post("/api/lieux").send({ raisonSociale: "SAS", enseigne: "Bar", typeLieuId: typeId, ...corps }).expect(201);
const position = async (id: number) => {
  const l = await prisma.lieu.findUniqueOrThrow({ where: { id } });
  return l.latitude === null ? null : [Number(l.latitude), Number(l.longitude)];
};

describe("géocodage des lieux", () => {
  it("place le lieu à partir de son adresse", async () => {
    const appels = geocodeurFactice();
    const { body } = await creer({ adresse: "1 rue Crébillon", codePostal: "44000", ville: "Nantes" });
    expect(await position(body.id)).toEqual([47.2184, -1.5536]);
    expect(appels[0]).toContain("data.geopf.fr/geocodage/search");
    expect(appels[0]).toContain("postcode=44000");
  });

  it("sans rue, ne cherche que parmi les communes", async () => {
    const appels = geocodeurFactice();
    await creer({ ville: "La Baule" });
    await creer({ adresse: "2 avenue des Ibis", ville: "La Baule" });
    expect(appels[0]).toContain("type=municipality");
    expect(appels[1]).not.toContain("type=municipality");
  });

  it("garde les coordonnées saisies à la main", async () => {
    geocodeurFactice();
    const { body } = await creer({ ville: "Nantes", latitude: 47.1, longitude: -1.6 });
    expect(await position(body.id)).toEqual([47.1, -1.6]);
  });

  it("repositionne quand l'adresse change, pas sinon", async () => {
    const appels = geocodeurFactice();
    const { body } = await creer({ ville: "Nantes" });
    const base = { raisonSociale: "SAS", enseigne: "Bar", typeLieuId: typeId, latitude: 47.2184, longitude: -1.5536 };

    await api.put(`/api/lieux/${body.id}`).send({ ...base, ville: "Nantes", notes: "rien" }).expect(200);
    expect(appels).toHaveLength(1); // adresse inchangée : pas de nouvel appel

    await api.put(`/api/lieux/${body.id}`).send({ ...base, ville: "La Baule" }).expect(200);
    expect(await position(body.id)).toEqual([47.2865, -2.3904]);
  });

  it("enregistre la fiche même si le géocodeur est indisponible", async () => {
    geocodeurFactice(true);
    const { body } = await creer({ ville: "Nantes" });
    expect(await position(body.id)).toBeNull();
  });

  it("place d'un coup les lieux sans coordonnées", async () => {
    await prisma.lieu.createMany({
      data: [
        { raisonSociale: "A", enseigne: "Bar de Nantes", ville: "Nantes", typeLieuId: typeId },
        { raisonSociale: "B", enseigne: "Bar inconnu", ville: "Zzz", typeLieuId: typeId },
      ],
    });
    geocodeurFactice();
    const res = (await api.post("/api/lieux/geocoder").expect(200)).body;
    expect(res).toEqual({ places: 1, introuvables: ["Bar inconnu"] });
  });
});

describe("carte", () => {
  it("donne la position et la performance de chaque lieu, CA par jour ouvert compris", async () => {
    const heure = (h: string) => new Date(`1970-01-01T${h}:00Z`);
    const lieu = await prisma.lieu.create({
      data: {
        raisonSociale: "SAS", enseigne: "Bar du Port", typeLieuId: typeId, latitude: 47.2184, longitude: -1.5536,
        // ouvert le vendredi et le samedi seulement
        horaires: { create: [5, 6].map((j) => ({ jourSemaine: j, ouverture: heure("18:00"), fermeture: heure("23:00") })) },
      },
    });
    await prisma.lieu.create({ data: { raisonSociale: "S", enseigne: "Sans position", typeLieuId: typeId } });
    const gamme = await prisma.gamme.create({ data: { code: "MT", libelle: "MT" } });
    const tm = await prisma.typeModulePaiement.create({ data: { code: "ING", libelle: "Ingenico" } });
    const borne = await prisma.borne.create({ data: { identifiant: "MT-1", gammeId: gamme.id, numeroSerie: "1" } });
    const jour = (s: string) => new Date(`${s}T00:00:00Z`);
    await prisma.aggJour.createMany({
      data: [
        { jour: jour("2026-09-04"), lieuId: lieu.id, borneId: borne.id, typeModuleId: tm.id, moyenPaiement: "CB", nbAcceptees: 10, caTtcCents: 40000, caHtCents: 1 },
        { jour: jour("2026-08-07"), lieuId: lieu.id, borneId: borne.id, typeModuleId: tm.id, moyenPaiement: "CB", nbAcceptees: 5, caTtcCents: 20000, caHtCents: 1 },
      ],
    });

    // Septembre 2026 : 8 vendredis et samedis
    const res = (await api.get("/api/stats/carte?du=2026-09-01&au=2026-09-30").expect(200)).body;
    const port = res.lieux.find((l: { enseigne: string }) => l.enseigne === "Bar du Port");
    expect(port).toMatchObject({ latitude: 47.2184, longitude: -1.5536, caTtcCents: 40000, joursOuverts: 8, caParJourOuvertCents: 5000, caPrecedentCents: 20000, evolution: 1 });
    expect(res.lieux.find((l: { enseigne: string }) => l.enseigne === "Sans position").latitude).toBeNull();
  });
});
