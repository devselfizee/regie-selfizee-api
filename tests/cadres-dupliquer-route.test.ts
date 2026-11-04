import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reglagesParDefaut } from "../src/config-evenement/reglages.js";

// « Dupliquer » un cadre de la fiche événement : copie vers une autre composition du même gabarit, avec une
// base simulée (pas de base de données).

const reglages = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
reglages.gabarits.choisis = [
  { id: "pola", gabarit: "pola" },
  { id: "pola-ab12", gabarit: "pola" },
  { id: "planche", gabarit: "planche" },
];

const base = vi.hoisted(() => {
  // Sans Keycloak : l'application prend l'utilisateur de développement (admin)
  delete process.env.KEYCLOAK_URL;
  return { cadres: new Map<string, Record<string, unknown>>(), audits: [] as unknown[] };
});
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { upsert: async () => ({ id: 1, email: "dev@local", nom: "Dev", prenom: "", role: "ADMIN", lieuId: null, isActive: true, keycloakSub: null }) },
    auditLog: { create: async ({ data }: { data: unknown }) => base.audits.push(data) },
    configEvenement: {
      findFirst: async ({ where }: { where: { habituel: boolean } }) => (where.habituel ? { id: 70, lieuId: 7, habituel: true, reglages } : null),
      update: async () => ({}),
    },
    cadreEvenement: {
      findUnique: async ({ where }: { where: { configEvenementId_compositionId: { compositionId: string } } }) =>
        base.cadres.get(where.configEvenementId_compositionId.compositionId) ?? null,
      upsert: async ({ where, create, update }: { where: { configEvenementId_compositionId: { compositionId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const id = where.configEvenementId_compositionId.compositionId;
        const avant = base.cadres.get(id);
        const apres = avant ? { ...avant, ...update } : { ...create };
        base.cadres.set(id, apres);
        return apres;
      },
    },
  },
}));
const { creerApp } = await import("../src/app.js");
const api = request(creerApp());

const original = {
  id: 1, configEvenementId: 70, lieuId: 7, compositionId: "pola", gabarit: "pola", nom: "La Ruche — pola", formatId: "polaroid", gabaritStudioId: "pol-1",
  nbPoses: 1, canvas: '{"objects":[]}', image: "data:image/png;base64,iVBORw0KGgo=", vignette: "data:image/jpeg;base64,/9j/", createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
  base.cadres = new Map([["pola", original]]);
  base.audits = [];
});

describe("dupliquer un cadre", () => {
  it("copie canvas, rendu et vignette vers la nouvelle composition, et le journalise", async () => {
    await api.post("/api/lieux/7/evenement/cadres/pola/dupliquer").send({ vers: "pola-ab12" }).expect(201);
    const copie = base.cadres.get("pola-ab12")!;
    expect(copie).toMatchObject({ compositionId: "pola-ab12", configEvenementId: 70, lieuId: 7, canvas: original.canvas, image: original.image, vignette: original.vignette, formatId: "polaroid", nbPoses: 1 });
    expect(base.cadres.get("pola")).toBe(original);
    expect(base.audits).toEqual([expect.objectContaining({ entiteId: "70:pola-ab12", action: "CREATION", apres: expect.objectContaining({ copieDe: "pola" }) })]);
  });

  it("refuse une autre composition du kit, une composition absente ou sans cadre à copier", async () => {
    expect((await api.post("/api/lieux/7/evenement/cadres/pola/dupliquer").send({ vers: "planche" }).expect(400)).body.message).toMatch(/même gabarit/);
    await api.post("/api/lieux/7/evenement/cadres/pola/dupliquer").send({ vers: "pola-zz99" }).expect(404);
    await api.post("/api/lieux/7/evenement/cadres/pola-ab12/dupliquer").send({ vers: "pola" }).expect(404);
    await api.post("/api/lieux/7/evenement/cadres/pola/dupliquer").send({ vers: "pola" }).expect(400);
  });
});
