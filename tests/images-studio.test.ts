import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";

// Images du studio enregistrées en fichiers (MEDIAS_DIR/studio/<sha256>.<ext>) au lieu de rester en base64 dans le dessin.

vi.hoisted(() => {
  delete process.env.KEYCLOAK_URL; // utilisateur de développement : admin
});
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { user: { upsert: async () => ({ id: 1, email: "dev@local", nom: "Dev", prenom: "", role: "ADMIN", lieuId: null, isActive: true }) } },
}));

const dossier = mkdtempSync(join(tmpdir(), "images-studio-"));
process.env.MEDIAS_DIR = dossier;
const { creerApp } = await import("../src/app.js");
const app = creerApp();
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: "#ed195f" } }).png().toBuffer();
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

describe("images du studio", () => {
  it("enregistrée une seule fois (nom = empreinte), servie sans jeton avec un cache long", async () => {
    const r = await request(app).post("/api/studio/images").send({ dataUrl }).expect(201);
    expect(r.body).toMatchObject({ largeur: 4, hauteur: 3 });
    expect(r.body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/studio\/v1\/images\/[0-9a-f]{64}\.png$/);
    const encore = await request(app).post("/api/studio/images").send({ dataUrl }).expect(201);
    expect(new URL(encore.body.url).pathname).toBe(new URL(r.body.url).pathname);
    expect(readdirSync(join(dossier, "studio"))).toHaveLength(1);

    const chemin = new URL(r.body.url).pathname;
    const f = await request(app).get(chemin).expect(200);
    expect(f.headers["content-type"]).toBe("image/png");
    expect(f.headers["cache-control"]).toContain("immutable");
    expect(f.headers["access-control-allow-origin"]).toBe("*");
    expect(Buffer.compare(f.body as Buffer, png)).toBe(0);
  });

  it("refuse ce qui n'est pas une image (le format est lu dans le fichier), et les noms inconnus", async () => {
    await request(app).post("/api/studio/images").send({ dataUrl: "pas une image" }).expect(400);
    await request(app).post("/api/studio/images").send({ dataUrl: `data:image/png;base64,${Buffer.from("<svg onload=x>").toString("base64")}` }).expect(400);
    await request(app).get("/studio/v1/images/../../etc/passwd").expect(404);
    await request(app).get(`/studio/v1/images/${"0".repeat(64)}.png`).expect(404);
  });
});
