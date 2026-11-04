import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reglagesParDefaut } from "../src/config-evenement/reglages.js";

// « Dupliquer » un événement de la borne : nouvel événement ponctuel avec les réglages et les cadres de
// l'original, aux dates saisies, avec une base simulée (pas de base de données).

const reglages = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") });
reglages.gabarits.choisis = [
  { id: "pola", gabarit: "pola" },
  { id: "bandelette", gabarit: "bandelette" },
];
reglages.tarifs.herite = false;

const base = vi.hoisted(() => {
  // Sans Keycloak : l'application prend l'utilisateur de développement (admin)
  delete process.env.KEYCLOAK_URL;
  return { crees: [] as Record<string, unknown>[], cadres: [] as Record<string, unknown>[], audits: [] as unknown[], habituel: true };
});
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { upsert: async () => ({ id: 1, email: "dev@local", nom: "Dev", prenom: "", role: "ADMIN", lieuId: null, isActive: true, keycloakSub: null }) },
    auditLog: { create: async ({ data }: { data: unknown }) => base.audits.push(data) },
    configEvenement: {
      findFirst: async ({ where }: { where: { habituel: boolean; id?: number } }) => {
        if (where.habituel) return base.habituel ? { id: 70, lieuId: 7, habituel: true, nom: null, code: "RAAA", reglages } : null;
        return where.id === 71 ? { id: 71, lieuId: 7, habituel: false, nom: "Halloween", code: "RBBB", reglages } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const e = { id: 90 + base.crees.length, ...data };
        base.crees.push(e);
        return e;
      },
    },
    cadreEvenement: {
      findMany: async ({ where }: { where: { configEvenementId: number } }) =>
        where.configEvenementId === 70
          ? [{ compositionId: "pola", gabarit: "pola", nom: "La Ruche — pola", formatId: "polaroid", gabaritStudioId: "pol-1", nbPoses: 1, canvas: "{}", image: "data:image/png;base64,AA", vignette: null }]
          : [],
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        base.cadres.push(...data);
        return { count: data.length };
      },
    },
  },
}));
const { creerApp } = await import("../src/app.js");
const api = request(creerApp());

beforeEach(() => {
  base.crees = [];
  base.cadres = [];
  base.audits = [];
  base.habituel = true;
});

const saisie = { nom: "Noël", dateDebut: "2026-12-20", dateFin: "2026-12-26" };

describe("dupliquer un événement", () => {
  it("copie les réglages et les cadres de l'événement par défaut dans un nouvel événement ponctuel", async () => {
    const r = await api.post("/api/lieux/7/evenement/dupliquer").send(saisie).expect(201);
    expect(r.body).toMatchObject({ id: 90, nom: "Noël", cadres: 1 });
    const [e] = base.crees as { habituel: boolean; nom: string; code: string; reglages: typeof reglages }[];
    expect(e.habituel).toBe(false);
    expect(e.nom).toBe("Noël");
    expect(e.code).not.toBe("RAAA");
    expect(e.reglages.gabarits.choisis).toEqual(reglages.gabarits.choisis);
    expect(e.reglages.tarifs.herite).toBe(false);
    expect(e.reglages.lieu).toMatchObject({ dateDebut: "2026-12-20", dateFin: "2026-12-26" });
    expect(base.cadres).toEqual([expect.objectContaining({ configEvenementId: 90, lieuId: 7, compositionId: "pola", canvas: "{}", image: "data:image/png;base64,AA" })]);
    expect(base.audits).toEqual([expect.objectContaining({ action: "CREATION", apres: expect.objectContaining({ copieDe: { id: 70, code: "RAAA", nom: null }, cadres: 1 }) })]);
  });

  it("duplique aussi un événement ponctuel", async () => {
    const r = await api.post("/api/lieux/7/evenements-ponctuels/71/dupliquer").send(saisie).expect(201);
    expect(r.body.cadres).toBe(0);
    expect(base.crees).toHaveLength(1);
  });

  it("refuse des dates à l'envers, un événement inconnu ou pas encore enregistré", async () => {
    await api.post("/api/lieux/7/evenement/dupliquer").send({ ...saisie, dateFin: "2026-12-01" }).expect(400);
    await api.post("/api/lieux/7/evenements-ponctuels/99/dupliquer").send(saisie).expect(404);
    base.habituel = false;
    await api.post("/api/lieux/7/evenement/dupliquer").send(saisie).expect(400);
    expect(base.crees).toHaveLength(0);
  });
});
