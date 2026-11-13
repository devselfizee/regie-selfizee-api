import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { genererCle } from "../src/lib/cleBorne.js";
import { cheminZip, empreinteZip, rangerZip } from "../src/config-evenement/zipBorne.js";

// Zip de l'événement chargé par la borne (comme getEvent + e/zip/download du booth) : état avec la clé de la borne,
// puis téléchargement sur URL signée et courte. Base simulée en mémoire, stockage dans un dossier temporaire.

const b = vi.hoisted(() => ({
  borne: null as null | Record<string, unknown>,
  affectations: [] as { borneId: number; lieuId: number; debut: Date; fin: Date | null }[],
  evenements: [] as Record<string, unknown>[],
  rejets: [] as unknown[],
  journal: [] as Record<string, unknown>[],
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    borne: { findUnique: async ({ where }: { where: { apiKeyPrefix: string } }) => (b.borne?.apiKeyPrefix === where.apiKeyPrefix ? b.borne : null) },
    affectationBorne: {
      findFirst: async ({ where }: { where: { borneId: number; debut: { lte: Date } } }) => {
        const t = where.debut.lte.getTime();
        return b.affectations.find((a) => a.borneId === where.borneId && a.debut.getTime() <= t && (!a.fin || a.fin.getTime() > t)) ?? null;
      },
    },
    configEvenement: { findUnique: async ({ where }: { where: { code: string } }) => b.evenements.find((e) => e.code === where.code) ?? null },
    importLot: { create: async ({ data }: { data: unknown }) => b.rejets.push(data) },
    installationEvenement: { create: async ({ data }: { data: Record<string, unknown> }) => b.journal.push(data), findFirst: async () => null },
  },
}));

const dossier = mkdtempSync(join(tmpdir(), "zip-borne-"));
process.env.MEDIAS_DIR = dossier;
const { creerApp } = await import("../src/app.js");
const app = creerApp();
const cle = genererCle();
const ZIP = Buffer.from("PK\u0003\u0004 faux zip de test");

const statut = (code: string, cleUtilisee = cle.cle, borneId = "SZ-001") =>
  request(app).post("/ingest/v1/evenements/statut").set("Authorization", `Bearer ${cleUtilisee}`).send({ borne_id: borneId, code });
const chemin = (url: string) => url.replace(/^https?:\/\/[^/]+/, "");

beforeEach(async () => {
  b.borne = { id: 1, identifiant: "SZ-001", apiKeyPrefix: cle.prefixe, apiKeyHash: cle.hash, statut: "EN_SERVICE" };
  b.affectations = [{ borneId: 1, lieuId: 7, debut: new Date("2026-01-01"), fin: null }];
  b.evenements = [
    { code: "RA7K", lieuId: 7, version: 3, publieeLe: new Date("2026-11-08T10:00:00Z"), ...empreinteZip("RA7K", 3, ZIP) },
    { code: "RNEW", lieuId: 7, version: 0, publieeLe: null, zipChemin: null, zipTaille: null, zipSha256: null },
    { code: "ROLD", lieuId: 7, version: 2, publieeLe: new Date("2026-10-01"), zipChemin: null, zipTaille: null, zipSha256: null },
    { code: "RAUT", lieuId: 9, version: 1, publieeLe: new Date("2026-10-01"), ...empreinteZip("RAUT", 1, ZIP) },
  ];
  b.rejets = [];
  b.journal = [];
  await rangerZip("RA7K", 3, ZIP);
});
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

describe("zip de l'événement pour la borne", () => {
  it("état « complete » : version, empreinte et URL signée ; le zip se télécharge, avec reprise possible", async () => {
    const r = await statut("ra7k").expect(200);
    expect(r.body).toMatchObject({ status: "complete", code: "RA7K", version: 3, taille: ZIP.length, sha256: empreinteZip("RA7K", 3, ZIP).zipSha256 });
    expect(r.body.url).toMatch(/\/ingest\/v1\/evenements\/RA7K\/zip\?v=3&exp=\d+&b=1&d=m&sig=[\w-]+$/);
    expect(new Date(r.body.expireLe).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);

    const z = await request(app).get(chemin(r.body.url)).buffer(true).parse((res, fin) => {
      const morceaux: Buffer[] = [];
      res.on("data", (c: Buffer) => morceaux.push(c));
      res.on("end", () => fin(null, Buffer.concat(morceaux)));
    }).expect(200);
    expect(z.headers["content-type"]).toBe("application/zip");
    expect(z.headers["content-disposition"]).toContain('filename="RA7K.zip"');
    expect(Buffer.compare(z.body as Buffer, ZIP)).toBe(0);
    const partiel = await request(app).get(chemin(r.body.url)).set("Range", "bytes=0-3").expect(206);
    expect(partiel.headers["content-length"]).toBe("4");
    // Journal : la demande, puis chaque envoi qui part du début ; une reprise au milieu du fichier ne compte pas
    await request(app).get(chemin(r.body.url)).set("Range", "bytes=4-7").expect(206);
    expect(b.journal.map((l) => [l.etat, l.declencheur, l.borneId, l.code, l.version, l.lieuId])).toEqual([
      ["DEMANDE", "MANUEL", 1, "RA7K", 3, 7],
      ["ENVOYE", "MANUEL", 1, "RA7K", 3, 7],
      ["ENVOYE", "MANUEL", 1, "RA7K", 3, 7],
    ]);
  });

  it("URL fausse, falsifiée ou expirée : 404 sans détail", async () => {
    const { url } = (await statut("RA7K").expect(200)).body as { url: string };
    await request(app).get(chemin(url).replace(/sig=[\w-]+/, "sig=faux")).expect(404);
    await request(app).get(chemin(url).replace("v=3", "v=2")).expect(404); // version changée : la signature ne suit pas
    await request(app).get(chemin(url).replace("/RA7K/", "/RAUT/")).expect(404); // autre événement
    await request(app).get(chemin(url).replace("b=1", "b=2")).expect(404); // autre borne : la signature ne suit pas
    await request(app).get(chemin(url).replace("d=m", "d=a")).expect(404);
    await request(app).get("/ingest/v1/evenements/RA7K/zip").expect(404);
    vi.useFakeTimers({ now: Date.now() + 16 * 60_000, toFake: ["Date"] });
    try {
      await request(app).get(chemin(url)).expect(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it("jamais publié : incomplete ; publié avant les zips figés : obsolete ; autre lieu ou code inconnu : unknown", async () => {
    expect((await statut("RNEW").expect(200)).body).toEqual({ status: "incomplete" });
    expect((await statut("ROLD").expect(200)).body).toMatchObject({ status: "obsolete", version: 2 });
    expect((await statut("RAUT").expect(200)).body).toEqual({ status: "unknown" }); // la borne n'est pas dans ce lieu
    expect((await statut("RZZZ").expect(200)).body).toEqual({ status: "unknown" });
    b.affectations[0].fin = new Date(Date.now() - 1000); // borne retirée du lieu
    expect((await statut("RA7K").expect(200)).body).toEqual({ status: "unknown" });
  });

  it("clé absente ou fausse, borne_id d'une autre borne, code mal formé : refusés et journalisés", async () => {
    await request(app).post("/ingest/v1/evenements/statut").send({ borne_id: "SZ-001", code: "RA7K" }).expect(401);
    await statut("RA7K", genererCle().cle).expect(401);
    await statut("RA7K", cle.cle, "SZ-002").expect(403);
    await statut("../etc").expect(400);
    expect(b.rejets).toHaveLength(4);
    expect(b.rejets.every((r) => (r as { type: string }).type === "CONFIG")).toBe(true);
  });

  it("le zip publié est rangé par version ; l'avant-dernière version est retirée", async () => {
    await rangerZip("RA7K", 4, ZIP);
    await rangerZip("RA7K", 5, ZIP);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dossier, cheminZip("RA7K", 3)))).toBe(false);
    expect(existsSync(join(dossier, cheminZip("RA7K", 4)))).toBe(true);
    expect(existsSync(join(dossier, cheminZip("RA7K", 5)))).toBe(true);
  });
});
