import JSZip from "jszip";
import sharp from "sharp";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { genererConfig, lireModele } from "../src/config-evenement/generation.js";
import { cheminsDansLeZip, formeDe, illustrationsAExporter, preparerIllustration } from "../src/config-evenement/illustrations.js";
import { reglagesParDefaut, type Reglages } from "../src/config-evenement/reglages.js";
import { genererZip } from "../src/config-evenement/zip.js";

// Illustrations des bornes (mémo ILLUSTRATIONS-ADMIN-WEB du 05/11/2026) : photos d'exemple des cases des
// cadres, rangées par forme dans le zip, et clés du config.json.

const base = vi.hoisted(() => {
  // Sans Keycloak : l'application prend l'utilisateur de développement (admin)
  delete process.env.KEYCLOAK_URL;
  return { photos: [] as Record<string, unknown>[], series: [] as Record<string, unknown>[], images: [] as Record<string, unknown>[], suivant: 1, touche: 0 };
});
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { upsert: async () => ({ id: 1, email: "dev@local", nom: "Dev", prenom: "", role: "ADMIN", lieuId: null, isActive: true, keycloakSub: null }) },
    auditLog: { create: async () => ({}) },
    configEvenement: {
      findFirst: async ({ where }: { where: { habituel: boolean } }) => (where.habituel ? { id: 70, lieuId: 7, habituel: true } : null),
      update: async () => {
        base.touche++;
        return {};
      },
    },
    illustrationEvenement: {
      findMany: async ({ where }: { where: { cible?: string } }) => base.photos.filter((p) => !where.cible || p.cible === where.cible),
      count: async ({ where }: { where: { cible: string } }) => base.photos.filter((p) => p.cible === where.cible).length,
      create: async ({ data, select }: { data: Record<string, unknown>; select: Record<string, boolean> }) => {
        const p: Record<string, unknown> = { id: base.suivant++, ...data };
        base.photos.push(p);
        return Object.fromEntries(Object.keys(select).map((k) => [k, p[k]]));
      },
      deleteMany: async ({ where }: { where: { id: number } }) => {
        const avant = base.photos.length;
        base.photos = base.photos.filter((p) => p.id !== where.id);
        return { count: avant - base.photos.length };
      },
    },
    illustrationSerie: {
      findMany: async () => base.series.map((x) => ({ ...x, images: base.images.filter((i) => i.serieId === x.id) })),
      findUnique: async ({ where }: { where: { id: number } }) => base.series.find((x) => x.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const x = { id: base.suivant++, actif: true, ...data };
        base.series.push(x);
        return x;
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => Object.assign(base.series.find((x) => x.id === where.id)!, data),
      delete: async ({ where }: { where: { id: number } }) => {
        base.series = base.series.filter((x) => x.id !== where.id);
        base.images = base.images.filter((i) => i.serieId !== where.id);
        return {};
      },
    },
    illustrationSerieImage: {
      findMany: async ({ where }: { where: { serieId: number } }) => base.images.filter((i) => i.serieId === where.serieId),
      count: async ({ where }: { where: { serieId: number } }) => base.images.filter((i) => i.serieId === where.serieId).length,
      create: async ({ data, select }: { data: Record<string, unknown>; select: Record<string, boolean> }) => {
        const i: Record<string, unknown> = { id: base.suivant++, ...data };
        base.images.push(i);
        return Object.fromEntries(Object.keys(select).map((k) => [k, i[k]]));
      },
      deleteMany: async ({ where }: { where: { id: number; serieId: number } }) => {
        const avant = base.images.length;
        base.images = base.images.filter((i) => !(i.id === where.id && i.serieId === where.serieId));
        return { count: avant - base.images.length };
      },
    },
  },
}));
const { creerApp } = await import("../src/app.js");
const api = request(creerApp());

const jpeg = (l: number, h: number) => sharp({ create: { width: l, height: h, channels: 3, background: { r: 200, g: 50, b: 50 } } }).jpeg().toBuffer();
const dataUrl = async (l: number, h: number) => `data:image/jpeg;base64,${(await jpeg(l, h)).toString("base64")}`;

beforeEach(() => {
  base.photos = [];
  base.series = [];
  base.images = [];
  base.suivant = 1;
  base.touche = 0;
});

describe("forme et préparation des photos", () => {
  it("carré de 0,85 à 1,18, portrait plus étroit, paysage plus large", () => {
    expect([formeDe(800, 800), formeDe(850, 1000), formeDe(1180, 1000), formeDe(800, 1200), formeDe(1200, 800)]).toEqual(["carre", "carre", "carre", "portrait", "paysage"]);
  });

  it("réduite à 1200 px de côté au plus, en JPEG, avec sa vignette", async () => {
    const p = await preparerIllustration(await jpeg(3000, 2000));
    expect(p).toMatchObject({ largeur: 1200, hauteur: 800, forme: "paysage" });
    expect((await sharp(p.image).metadata()).format).toBe("jpeg");
    expect((await sharp(p.vignette).metadata()).width).toBe(240);
  });

  it("rangées par série et par forme, numérotées : illustrations/carre/01.jpg…", () => {
    expect(cheminsDansLeZip([{ cible: "cadres", forme: "carre" }, { cible: "cadres", forme: "paysage" }, { cible: "cadres", forme: "carre" }, { cible: "accueil", forme: "portrait" }])).toEqual([
      "illustrations/carre/01.jpg",
      "illustrations/paysage/01.jpg",
      "illustrations/carre/02.jpg",
      "illustrations-accueil/portrait/01.jpg",
    ]);
  });
});

describe("config.json et zip", () => {
  const avec = (illustrations: Reglages["lieu"]["illustrations"], accueil: Reglages["lieu"]["illustrationsAccueil"]) => {
    const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
    r.gabarits = { choisis: [{ id: "pola", gabarit: "pola" }], accueil: ["pola"] };
    r.lieu.illustrations = illustrations;
    r.lieu.illustrationsAccueil = accueil;
    return r;
  };
  const reglagesBorne = (r: Reglages) => genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires: [], maintenant: new Date() }).userSettings;

  it("séries du logiciel, caméra, cases unies, série d'accueil", () => {
    expect(reglagesBorne(avec("festif", "memes"))).toMatchObject({ illustrationSet: "festif" });
    expect(reglagesBorne(avec("festif", "memes"))).not.toHaveProperty("welcomeIllustrationSet");
    expect(reglagesBorne(avec("festif", "memes"))).not.toHaveProperty("previewFillHoles");
    expect(reglagesBorne(avec("chic", "festif"))).toMatchObject({ illustrationSet: "chic", welcomeIllustrationSet: "festif" });
    expect(reglagesBorne(avec("camera", "memes"))).toMatchObject({ illustrationSet: "none" });
    expect(reglagesBorne(avec("aucune", "memes"))).toMatchObject({ previewFillHoles: false });
    // Photos de l'événement : le dossier du zip passe en premier, « festif » en repli
    expect(reglagesBorne(avec("photos", "photos"))).toMatchObject({ illustrationSet: "festif", welcomeIllustrationSet: "illustrations-accueil" });
  });

  it("à exporter : photos de l'événement ou série de la bibliothèque, selon le choix de chaque série", async () => {
    const image = new Uint8Array([1]);
    base.photos = [{ id: 1, cible: "cadres", forme: "carre", image }, { id: 2, cible: "accueil", forme: "portrait", image }];
    base.images = [{ id: 3, serieId: 9, forme: "paysage", image }];
    const resume = async (r: Reglages) => (await illustrationsAExporter(r, 70)).map((i) => `${i.cible}:${i.forme}`);
    expect(await resume(avec("photos", "memes"))).toEqual(["cadres:carre"]);
    expect(await resume(avec("photos", "photos"))).toEqual(["cadres:carre", "accueil:portrait"]);
    expect(await resume(avec("festif", "memes"))).toEqual([]);
    const serie = avec("serie", "serie");
    serie.lieu.illustrationsSerieId = 9;
    serie.lieu.illustrationsAccueilSerieId = 9;
    expect(await resume(serie)).toEqual(["cadres:paysage", "accueil:paysage"]);
    expect(reglagesBorne(serie)).toMatchObject({ illustrationSet: "festif", welcomeIllustrationSet: "illustrations-accueil" });
  });

  it("zip : les images retenues, rangées par série et par forme", async () => {
    const image = await jpeg(10, 10);
    const r = avec("photos", "photos");
    const config = genererConfig({ code: "RA7K", motDePasseTableau: "MDP23456", reglages: r, horaires: [], maintenant: new Date() });
    const illustrations = [{ cible: "cadres" as const, forme: "carre", image }, { cible: "accueil" as const, forme: "portrait", image }];
    const zip = await JSZip.loadAsync(await genererZip({ config, modele: lireModele(), reglages: r, cadres: [], illustrations, maintenant: new Date() }));
    expect(Object.keys(zip.files).filter((n) => n.startsWith("illustrations") && !n.endsWith("/"))).toEqual(["illustrations/carre/01.jpg", "illustrations-accueil/portrait/01.jpg"]);
  }, 60_000);
});

describe("routes des photos de l'événement", () => {
  it("ajout : réduite, rangée par forme, vignette en data URL ; liste ; retrait", async () => {
    const r = await api.post("/api/lieux/7/evenement/illustrations").send({ cible: "cadres", image: await dataUrl(1600, 1200) }).expect(201);
    expect(r.body).toMatchObject({ id: 1, cible: "cadres", forme: "paysage", largeur: 1200, hauteur: 900 });
    expect(r.body.vignette).toMatch(/^data:image\/jpeg;base64,/);
    expect(base.touche).toBe(1);
    expect((await api.get("/api/lieux/7/evenement/illustrations").expect(200)).body).toHaveLength(1);
    await api.delete("/api/lieux/7/evenement/illustrations/1").expect(204);
    await api.delete("/api/lieux/7/evenement/illustrations/1").expect(404);
    expect(base.photos).toEqual([]);
  });

  it("refuse ce qui n'est pas une image, une série pleine, une cible inconnue", async () => {
    await api.post("/api/lieux/7/evenement/illustrations").send({ cible: "cadres", image: "data:image/png;base64,AAAA" }).expect(400);
    await api.post("/api/lieux/7/evenement/illustrations").send({ cible: "fond", image: await dataUrl(10, 10) }).expect(400);
    base.photos = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, cible: "cadres" }));
    expect((await api.post("/api/lieux/7/evenement/illustrations").send({ cible: "cadres", image: await dataUrl(10, 10) }).expect(400)).body.message).toMatch(/20 photos au plus/);
    await api.post("/api/lieux/7/evenement/illustrations").send({ cible: "accueil", image: await dataUrl(10, 10) }).expect(201);
  });
});

describe("bibliothèque des séries", () => {
  it("créer, ajouter une photo, lister avec les formes et un aperçu, renommer, retirer, supprimer", async () => {
    const serie = (await api.post("/api/illustrations-series").send({ nom: "Mariage" }).expect(201)).body;
    expect(serie).toMatchObject({ nom: "Mariage", nbImages: 0 });
    const img = (await api.post(`/api/illustrations-series/${serie.id}/images`).send({ image: await dataUrl(800, 800) }).expect(201)).body;
    expect(img).toMatchObject({ forme: "carre", largeur: 800, hauteur: 800 });
    const liste = (await api.get("/api/illustrations-series").expect(200)).body;
    expect(liste[0]).toMatchObject({ nom: "Mariage", nbImages: 1, formes: { carre: 1, portrait: 0, paysage: 0 } });
    expect(liste[0].apercus[0]).toMatch(/^data:image\/jpeg;base64,/);
    await api.patch(`/api/illustrations-series/${serie.id}`).send({ nom: "Mariages" }).expect(200);
    expect((await api.get(`/api/illustrations-series/${serie.id}/images`).expect(200)).body).toHaveLength(1);
    await api.delete(`/api/illustrations-series/${serie.id}/images/${img.id}`).expect(204);
    await api.delete(`/api/illustrations-series/${serie.id}`).expect(204);
    await api.get(`/api/illustrations-series/${serie.id}/images`).expect(404);
  });

  it("refuse un nom vide, une série inconnue, une 21e photo", async () => {
    await api.post("/api/illustrations-series").send({ nom: " " }).expect(400);
    await api.post("/api/illustrations-series/999/images").send({ image: await dataUrl(10, 10) }).expect(404);
    const serie = (await api.post("/api/illustrations-series").send({ nom: "Corporate" }).expect(201)).body;
    base.images = Array.from({ length: 20 }, (_, i) => ({ id: 500 + i, serieId: serie.id }));
    await api.post(`/api/illustrations-series/${serie.id}/images`).send({ image: await dataUrl(10, 10) }).expect(400);
  });

  it("une fiche qui choisit « série » sans en désigner une ne se publie pas", async () => {
    const { controler } = await import("../src/config-evenement/reglages.js");
    const r = reglagesParDefaut({ enseigne: "X", ville: null, dateInstallation: null });
    r.gabarits.choisis = [{ id: "pola", gabarit: "pola" }];
    r.lieu.illustrations = "serie";
    expect(controler(r, true).filter((c) => c.niveau === "erreur").map((c) => c.message)).toEqual([expect.stringMatching(/choisissez une série/)]);
  });
});
