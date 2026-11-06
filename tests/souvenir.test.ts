import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reglagesParDefaut } from "../src/config-evenement/reglages.js";
import { ecrireBuffer } from "../src/lib/stockage.js";
import { ecrireJeton, lireJeton } from "../src/souvenir/jeton.js";

// API de la page souvenir : séance par jeton (événement, état, visuels signés), code de séance, fichiers signés.
// Base simulée : les médias sont de vrais fichiers sur un dossier temporaire.

type Ligne = Record<string, unknown> & { id: number; uuid: string; photoUuid: string | null; test: boolean; createdAt: Date };
const base = vi.hoisted(() => ({ medias: [] as Ligne[], reglages: {} as unknown, illustrations: [] as { id: number; configEvenementId: number; cible: string; image: Uint8Array }[] }));
const garde = (m: Ligne, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    if (k === "test") return m.test === v;
    if (k === "photoUuid") return v && typeof v === "object" ? m.photoUuid !== null : m.photoUuid === v;
    if (k === "brut") return (m.brut as Record<string, unknown> | null)?.session_code === (v as { equals: string }).equals;
    if (k === "createdAt") return m.createdAt >= (v as { gte: Date }).gte;
    return m[k] === v;
  });
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    configEvenement: {
      findUnique: async ({ where }: { where: { code: string } }) =>
        where.code === "RA7K" ? { id: 70, lieuId: 7, code: "RA7K", habituel: true, reglages: base.reglages, lieu: { id: 7, enseigne: "La Ruche", ville: "Trégueux", infosBorne: null } } : null,
      findFirst: async () => ({ reglages: base.reglages }),
    },
    grilleTarifs: { findFirst: async () => null, findUnique: async () => null },
    media: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => base.medias.filter((m) => garde(m, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => base.medias.filter((m) => garde(m, where)).at(-1) ?? null,
      findUnique: async ({ where }: { where: { uuid: string } }) => base.medias.find((m) => m.uuid === where.uuid) ?? null,
    },
    illustrationEvenement: {
      findMany: async ({ where }: { where: { configEvenementId: number; cible: string } }) => base.illustrations.filter((i) => i.configEvenementId === where.configEvenementId && i.cible === where.cible),
      findUnique: async ({ where }: { where: { id: number } }) => base.illustrations.find((i) => i.id === where.id) ?? null,
    },
    illustrationSerieImage: { findMany: async () => [], findUnique: async () => null },
  },
}));

const { creerApp } = await import("../src/app.js");
const app = creerApp();
const SECRET = "secret-de-test-souvenir";
const serveur = (url: string) => request(app).get(url).set("X-Souvenir-Token", SECRET);

const UUID = "3f9ac0e1-b27d-4c58-a6e9-0d14b7c2f581";
const UUID_ATTENTE = "c27e9a4f-1d8b-4e06-a3f5-b7d29e1c8a40";
const UUID_VIEUX = "5d0e8c3a-9f2b-4716-b8e4-a1c7d6f39b25";
const UUID_TEST = "a6c93e1f-5b0d-4a72-88e1-f4b9d2a7e036";
const jeton = (u: string) => `RA7K-${u.replace(/-/g, "")}`;

let dossier: string;
let photo: Buffer;
let gif: Buffer;

beforeAll(async () => {
  dossier = await mkdtemp(join(tmpdir(), "regie-souvenir-"));
  process.env.MEDIAS_DIR = dossier;
  photo = await sharp({ create: { width: 2400, height: 3600, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
  gif = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#cc3366" } }).gif().toBuffer();
});
afterAll(async () => {
  delete process.env.SOUVENIR_API_SECRET;
  await rm(dossier, { recursive: true, force: true });
});

let n = 0;
async function media(o: { photoUuid: string; dateSave?: Date; fichier?: "jpg" | "gif" | null; test?: boolean; sessionCode?: string }) {
  n++;
  const uuid = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const fichier = o.fichier === undefined ? "jpg" : o.fichier;
  const chemin = fichier ? `00/${uuid}.${fichier}` : null;
  if (chemin) await ecrireBuffer(chemin, fichier === "gif" ? gif : photo);
  base.medias.push({
    id: n, uuid, codeEvent: "RA7K", photoUuid: o.photoUuid, test: o.test ?? false, createdAt: o.dateSave ?? new Date(),
    dateSave: o.dateSave ?? null, datePhoto: null, brut: o.sessionCode ? { session_code: o.sessionCode } : null,
    mediaStatut: chemin ? "TELECHARGE" : "A_TELECHARGER", mediaChemin: chemin,
  });
}

beforeEach(async () => {
  process.env.SOUVENIR_API_SECRET = SECRET;
  delete process.env.SOUVENIR_SEANCES_TEST;
  const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: null });
  r.tarifs.herite = false;
  r.tarifs.paliers = [{ de: 1, prixCents: 350 }, { de: 2, prixCents: 300 }];
  r.tarifs.palierMisEnAvant = 2;
  r.tarifs.reimpressionWeb = true;
  r.tarifs.libelleMisEnAvant = "Le plus populaire";
  r.lieu.avisGoogleUrl = "https://g.page/r/la-ruche/review";
  r.lieu.instagram = "@laruche";
  base.reglages = r;
  base.medias = [];
  base.illustrations = [];
  const recent = new Date(Date.now() - 3_600_000);
  await media({ photoUuid: UUID, dateSave: recent, sessionCode: "K7PX2M" });
  await media({ photoUuid: UUID, dateSave: recent, fichier: "gif" });
  await media({ photoUuid: UUID_ATTENTE, fichier: null });
  await media({ photoUuid: UUID_VIEUX, dateSave: new Date(Date.now() - 91 * 86_400_000) });
  await media({ photoUuid: UUID_TEST, dateSave: recent, test: true });
});

describe("jeton de la page souvenir", () => {
  it("lit le code et le photo_uuid, avec ou sans tiret, uuid avec ou sans tirets", () => {
    const attendu = { code: "RA7K", photoUuid: UUID };
    expect(lireJeton(jeton(UUID))).toEqual(attendu);
    expect(lireJeton(`RA7K${UUID.replace(/-/g, "")}`)).toEqual(attendu);
    expect(lireJeton(`ra7k-${UUID.toUpperCase()}`)).toEqual(attendu);
    expect(lireJeton("RA7K-pas-un-uuid")).toBeNull();
    expect(lireJeton(UUID.replace(/-/g, ""))).toBeNull(); // sans code
    expect(lireJeton(`R/../-${UUID}`)).toBeNull();
    expect(ecrireJeton("RA7K", UUID)).toBe(jeton(UUID));
  });
});

describe("GET /souvenir/v1/seances/:token", () => {
  it("refuse sans le secret, et répond 503 tant qu'il n'est pas configuré", async () => {
    await request(app).get(`/souvenir/v1/seances/${jeton(UUID)}`).expect(401);
    await request(app).get(`/souvenir/v1/seances/${jeton(UUID)}`).set("X-Souvenir-Token", "faux").expect(401);
    delete process.env.SOUVENIR_API_SECRET;
    await serveur(`/souvenir/v1/seances/${jeton(UUID)}`).expect(503);
  });

  it("renvoie l'événement avec ses vrais réglages et les visuels signés, photo puis GIF", async () => {
    const r = await serveur(`/souvenir/v1/seances/${jeton(UUID)}`).expect(200);
    expect(r.body).toMatchObject({
      token: jeton(UUID),
      etat: "disponible",
      codeSeance: "K7PX2M",
      evenement: {
        code: "RA7K",
        lieu: "La Ruche",
        ville: "Trégueux",
        jeu: { actif: true, lots: { free: 5, pct50: 10, pct30: 35, none: 50 }, maxLotsParJour: 50 },
        reimpressionWeb: true,
        tarifs: { paliers: [{ from: 1, unitPrice: 3.5 }, { from: 2, unitPrice: 3 }], populaire: 2, libellePopulaire: "Le plus populaire" },
        ton: "club",
        liens: { avisGoogle: "https://g.page/r/la-ruche/review", instagram: "@laruche", tiktok: null, hashtag: null },
        illustrations: [],
      },
    });
    expect(r.body.visuels.map((v: { type: string }) => v.type)).toEqual(["photo", "gif"]);
    // Photo réduite à 1600 px sur le côté long, proportions gardées
    expect(r.body.visuels[0]).toMatchObject({ largeur: 1067, hauteur: 1600 });
    expect(r.body.visuels[1]).toMatchObject({ largeur: 400, hauteur: 300 });
    // Aucun identifiant interne ni chemin de stockage dans la réponse
    expect(JSON.stringify(r.body)).not.toMatch(/mediaChemin|00\/0000|brut|motDePasse/);

    // L'URL signée sert le fichier sans autre authentification ; altérée, sans signature ou pour un autre fichier : 404
    const url = new URL(r.body.visuels[0].url);
    const f = await request(app).get(url.pathname + url.search).expect(200);
    expect(f.headers["content-type"]).toBe("image/jpeg");
    expect(f.headers["cache-control"]).toMatch(/^private, max-age=\d+$/);
    const meta = await sharp(f.body).metadata();
    expect([meta.width, meta.height]).toEqual([1067, 1600]);
    await request(app).get(url.pathname + url.search.replace(/sig=./, "sig=x")).expect(404);
    await request(app).get(url.pathname).expect(404);
    const autre = new URL(r.body.visuels[1].url);
    await request(app).get(autre.pathname + url.search).expect(404);
    expect((await request(app).get(autre.pathname + autre.search).expect(200)).headers["content-type"]).toBe("image/gif");
  });

  it("une URL expirée ne sert plus rien", async () => {
    const r = await serveur(`/souvenir/v1/seances/${jeton(UUID)}`).expect(200);
    const url = new URL(r.body.visuels[0].url);
    vi.useFakeTimers({ now: Date.now() + 7 * 3600_000, toFake: ["Date"] });
    try {
      await request(app).get(url.pathname + url.search).expect(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it("séance pas encore reçue : en attente ; plus de 90 jours : expirée ; événement inconnu ou jeton absurde : 404", async () => {
    expect((await serveur(`/souvenir/v1/seances/${jeton(UUID_ATTENTE)}`).expect(200)).body).toMatchObject({ etat: "en-attente", visuels: [] });
    expect((await serveur(`/souvenir/v1/seances/RA7K-${"ab".repeat(16)}`).expect(200)).body).toMatchObject({ etat: "en-attente", visuels: [] });
    expect((await serveur(`/souvenir/v1/seances/${jeton(UUID_VIEUX)}`).expect(200)).body).toMatchObject({ etat: "expiree", visuels: [] });
    await serveur(`/souvenir/v1/seances/RZZZ-${UUID.replace(/-/g, "")}`).expect(404);
    await serveur("/souvenir/v1/seances/n-importe-quoi").expect(404);
  });

  it("les séances de test ne sont pas montrées, sauf en recette", async () => {
    expect((await serveur(`/souvenir/v1/seances/${jeton(UUID_TEST)}`).expect(200)).body.etat).toBe("en-attente");
    process.env.SOUVENIR_SEANCES_TEST = "1";
    expect((await serveur(`/souvenir/v1/seances/${jeton(UUID_TEST)}`).expect(200)).body.etat).toBe("disponible");
  });

  it("photos d'exemple de l'événement en URLs signées", async () => {
    const image = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#ffe14d" } }).jpeg().toBuffer();
    base.illustrations.push({ id: 5, configEvenementId: 70, cible: "cadres", image: new Uint8Array(image) });
    (base.reglages as { lieu: { illustrations: string } }).lieu.illustrations = "photos";
    const r = await serveur(`/souvenir/v1/seances/${jeton(UUID)}`).expect(200);
    expect(r.body.evenement.illustrations).toHaveLength(1);
    const url = new URL(r.body.evenement.illustrations[0]);
    expect((await request(app).get(url.pathname + url.search).expect(200)).headers["content-type"]).toBe("image/jpeg");
    await request(app).get(url.pathname.replace("/5", "/6") + url.search).expect(404);
  });
});

describe("POST /souvenir/v1/code", () => {
  it("code de séance → jeton de la séance ; inconnu → 404 ; sans le secret → 401", async () => {
    const r = await request(app).post("/souvenir/v1/code").set("X-Souvenir-Token", SECRET).send({ code: "k7px-2m" }).expect(200);
    expect(r.body).toEqual({ token: jeton(UUID) });
    await request(app).post("/souvenir/v1/code").set("X-Souvenir-Token", SECRET).send({ code: "ZZZZZZ" }).expect(404);
    await request(app).post("/souvenir/v1/code").send({ code: "K7PX2M" }).expect(401);
  });
});
