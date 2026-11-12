import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reglagesParDefaut } from "../src/config-evenement/reglages.js";

// « Utiliser comme événement par défaut » (retour du 12/11) : le par défaut reprend le contenu d'un événement
// personnalisé (réglages, cadres, photos d'exemple) et garde son code ; l'original est supprimé seulement sur demande.
// Base simulée (pas de base de données).

const lieu = { enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-10-06T00:00:00Z") };
const defaut = reglagesParDefaut(lieu);
const halloween = reglagesParDefaut(lieu);
halloween.gabarits.choisis = [{ id: "pola", gabarit: "pola" }];
halloween.tarifs.herite = false;
halloween.lieu.dateDebut = "2026-10-31";
halloween.lieu.dateFin = "2026-11-01";
halloween.lieu.heureDebut = "20:00";

const base = vi.hoisted(() => {
  delete process.env.KEYCLOAK_URL; // utilisateur de développement : admin
  return {
    habituel: true,
    maj: [] as { where: { id: number }; data: Record<string, unknown> }[],
    crees: [] as Record<string, unknown>[],
    supprimes: [] as unknown[],
    cadresSupprimes: [] as unknown[],
    cadres: [] as Record<string, unknown>[],
    illustrations: [] as Record<string, unknown>[],
  };
});
vi.mock("../src/tarifs/grille.js", async (original) => ({
  ...(await original<typeof import("../src/tarifs/grille.js")>()),
  grilleEffective: async () => ({ grille: { paliers: [{ de: 1, prixCents: 350 }], palierMisEnAvant: null, libelleMisEnAvant: "", plusUnCents: 200 }, origine: "BASE" }),
}));
vi.mock("../src/lib/prisma.js", () => {
  const op = <T,>(f: () => T) => f(); // $transaction reçoit les promesses déjà lancées
  return {
    prisma: {
      user: { upsert: async () => ({ id: 1, email: "dev@local", nom: "Dev", prenom: "", role: "ADMIN", lieuId: null, isActive: true, keycloakSub: null }) },
      auditLog: { create: async () => ({}) },
      lieu: { findUnique: async () => ({ id: 7, ...lieu, infosBorne: null, horaires: [] }) },
      configEvenement: {
        findFirst: async ({ where }: { where: { habituel: boolean; id?: number } }) => {
          if (where.habituel) return base.habituel ? { id: 70, lieuId: 7, habituel: true, nom: null, code: "RAAA", reglages: defaut } : null;
          return where.id === 71 ? { id: 71, lieuId: 7, habituel: false, nom: "Halloween", code: "RBBB", reglages: halloween } : null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const e = { id: 80, ...data };
          base.crees.push(e);
          return e;
        },
        update: async (a: { where: { id: number }; data: Record<string, unknown> }) => op(() => base.maj.push(a)),
        delete: async ({ where }: { where: { id: number } }) => op(() => base.supprimes.push(where.id)),
      },
      cadreEvenement: {
        findMany: async ({ where }: { where: { configEvenementId: number } }) =>
          where.configEvenementId === 71 ? [{ compositionId: "pola", gabarit: "pola", nom: "Halloween — pola", formatId: "polaroid", gabaritStudioId: null, nbPoses: 1, canvas: "{}", image: "data:,", vignette: null }] : [],
        deleteMany: async ({ where }: { where: { configEvenementId: number } }) => op(() => base.cadresSupprimes.push(where.configEvenementId)),
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => op(() => base.cadres.push(...data)),
      },
      illustrationEvenement: {
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => op(() => base.illustrations.push(...data)),
      },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    },
  };
});
const { creerApp } = await import("../src/app.js");
const api = request(creerApp());

beforeEach(() => {
  base.habituel = true;
  base.maj = [];
  base.crees = [];
  base.supprimes = [];
  base.cadresSupprimes = [];
  base.cadres = [];
  base.illustrations = [];
});

describe("utiliser un événement comme événement par défaut", () => {
  it("le par défaut reprend réglages et cadres, garde son code et ses dates ; l'original reste", async () => {
    const r = await api.post("/api/lieux/7/evenements-ponctuels/71/devenir-defaut").send({}).expect(200);
    expect(r.body).toMatchObject({ id: 70, code: "RAAA", cadres: 1, origineSupprimee: false });
    const [maj] = base.maj;
    expect(maj.where.id).toBe(70);
    const r2 = maj.data.reglages as typeof halloween;
    expect(r2.gabarits.choisis).toEqual([{ id: "pola", gabarit: "pola" }]);
    expect(r2.tarifs.herite).toBe(false);
    expect(r2.lieu).toMatchObject({ dateDebut: defaut.lieu.dateDebut, dateFin: defaut.lieu.dateFin, heureDebut: defaut.lieu.heureDebut });
    expect(base.cadresSupprimes).toEqual([70]);
    expect(base.cadres).toEqual([expect.objectContaining({ configEvenementId: 70, lieuId: 7, compositionId: "pola" })]);
    expect(base.supprimes).toEqual([]);
  });

  it("avec « supprimer », l'original part ; sans par défaut enregistré, il est créé", async () => {
    base.habituel = false;
    const r = await api.post("/api/lieux/7/evenements-ponctuels/71/devenir-defaut").send({ supprimer: true }).expect(200);
    expect(r.body).toMatchObject({ id: 80, origineSupprimee: true });
    expect(base.crees[0]).toMatchObject({ habituel: true, nom: null });
    expect(base.supprimes).toEqual([71]);
    await api.post("/api/lieux/7/evenements-ponctuels/99/devenir-defaut").send({}).expect(404);
  });
});
