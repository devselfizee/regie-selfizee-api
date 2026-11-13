import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { genererCle } from "../src/lib/cleBorne.js";
import { reglagesParDefaut } from "../src/config-evenement/reglages.js";
import { empreinteZip, rangerZip } from "../src/config-evenement/zipBorne.js";

// Mise à jour automatique des événements sur la borne : programme (événement à faire tourner maintenant et prochains),
// versions de plusieurs codes, signalement des installations. Base simulée, stockage dans un dossier temporaire.

const b = vi.hoisted(() => ({
  borne: null as null | Record<string, unknown>,
  affectations: [] as { borneId: number; lieuId: number; debut: Date; fin: Date | null }[],
  evenements: [] as Record<string, unknown>[],
  installations: [] as Record<string, unknown>[],
  rejets: [] as unknown[],
}));

vi.mock("../src/lib/prisma.js", () => {
  const correspond = (e: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (v && typeof v === "object" && "in" in v ? (v.in as unknown[]).includes(e[k]) : e[k] === v));
  return {
    prisma: {
      borne: { findUnique: async ({ where }: { where: { apiKeyPrefix: string } }) => (b.borne?.apiKeyPrefix === where.apiKeyPrefix ? b.borne : null) },
      affectationBorne: {
        findFirst: async ({ where }: { where: { borneId: number; debut: { lte: Date } } }) => {
          const t = where.debut.lte.getTime();
          return b.affectations.find((a) => a.borneId === where.borneId && a.debut.getTime() <= t && (!a.fin || a.fin.getTime() > t)) ?? null;
        },
      },
      lieu: { findUnique: async () => ({ id: 7, enseigne: "La Ruche" }) },
      configEvenement: {
        findUnique: async ({ where }: { where: { code: string } }) => b.evenements.find((e) => e.code === where.code) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) => b.evenements.filter((e) => correspond(e, where)),
      },
      installationEvenement: { create: async ({ data }: { data: Record<string, unknown> }) => b.installations.push(data) },
      importLot: { create: async ({ data }: { data: unknown }) => b.rejets.push(data) },
    },
  };
});

const dossier = mkdtempSync(join(tmpdir(), "programme-borne-"));
process.env.MEDIAS_DIR = dossier;
const { creerApp } = await import("../src/app.js");
const app = creerApp();
const cle = genererCle();
const ZIP = Buffer.from("PK\u0003\u0004 faux zip");
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

const lieu = { enseigne: "La Ruche", ville: "Trégueux", dateInstallation: new Date("2026-01-01T00:00:00Z") };
function evenement(code: string, d: { habituel?: boolean; nom?: string; version?: number; debut?: string; fin?: string; hDebut?: string | null; hFin?: string | null; zip?: boolean; lieuId?: number }) {
  const r = reglagesParDefaut(lieu);
  if (d.debut) Object.assign(r.lieu, { dateDebut: d.debut, dateFin: d.fin ?? d.debut, heureDebut: d.hDebut ?? null, heureFin: d.hFin ?? null });
  const version = d.version ?? 1;
  return {
    id: code.charCodeAt(1), code, lieuId: d.lieuId ?? 7, habituel: Boolean(d.habituel), nom: d.habituel ? null : d.nom ?? code, reglages: r, version,
    publieeLe: version ? new Date("2026-11-10T09:00:00Z") : null,
    ...(d.zip === false || !version ? { zipChemin: null, zipTaille: null, zipSha256: null } : empreinteZip(code, version, ZIP)),
  };
}

const appel = (chemin: string, corps: Record<string, unknown> = {}) =>
  request(app).post(`/ingest/v1/evenements/${chemin}`).set("Authorization", `Bearer ${cle.cle}`).send({ borne_id: "SZ-001", ...corps });

beforeEach(async () => {
  // Le 13/11/2026 à 15:00, heure de Paris
  vi.useFakeTimers({ now: new Date("2026-11-13T14:00:00Z"), toFake: ["Date"] });
  b.borne = { id: 1, identifiant: "SZ-001", apiKeyPrefix: cle.prefixe, apiKeyHash: cle.hash, statut: "EN_SERVICE" };
  b.affectations = [{ borneId: 1, lieuId: 7, debut: new Date("2026-01-01"), fin: null }];
  b.evenements = [
    evenement("RDEF", { habituel: true, version: 3 }),
    evenement("RHAL", { nom: "Halloween", debut: "2026-11-12", fin: "2026-11-14" }),
    evenement("RNOE", { nom: "Noël", debut: "2026-11-20", fin: "2026-11-21", hDebut: "20:00", hFin: "06:00" }),
    evenement("RBRO", { nom: "Brouillon", debut: "2026-11-15", version: 0 }),
    evenement("ROLD", { nom: "Passé", debut: "2026-10-01" }),
    evenement("RAUT", { nom: "Autre lieu", debut: "2026-11-12", fin: "2026-11-30", lieuId: 9 }),
  ];
  b.installations = [];
  b.rejets = [];
  for (const e of b.evenements) if (e.zipChemin) await rangerZip(String(e.code), Number(e.version), ZIP);
});

describe("programme de la borne", () => {
  it("l'événement personnalisé en cours, jusqu'à sa fin ; les prochains sur 14 jours, prêts ou non", async () => {
    const r = (await appel("programme").expect(200)).body;
    expect(r.lieu).toEqual({ id: 7, nom: "La Ruche" });
    expect(r.maintenant).toBe("2026-11-13T15:00:00.000+01:00");
    expect(r.actuel).toMatchObject({ code: "RHAL", nom: "Halloween", parDefaut: false, version: 1, status: "complete", jusqua: "2026-11-15T00:00:00.000+01:00" });
    expect(r.prochains.map((p: { code: string }) => p.code)).toEqual(["RBRO", "RNOE"]);
    expect(r.prochains[0]).toMatchObject({ status: "incomplete", version: 0 });
    expect(r.prochains[1]).toMatchObject({ debut: "2026-11-20T20:00:00.000+01:00", fin: "2026-11-21T06:00:00.000+01:00", status: "complete" });
    vi.useRealTimers();
  });

  it("événement en cours pas prêt (zip absent) : le par défaut, jusqu'au prochain événement prêt", async () => {
    b.evenements = b.evenements.map((e) => (e.code === "RHAL" ? { ...e, zipChemin: null, zipTaille: null, zipSha256: null } : e));
    const r = (await appel("programme").expect(200)).body;
    vi.useRealTimers();
    expect(r.actuel).toMatchObject({ code: "RDEF", nom: null, parDefaut: true, version: 3, status: "complete", jusqua: "2026-11-20T20:00:00.000+01:00" });
  });

  it("borne non affectée : ni lieu ni événement ; clé fausse : 401", async () => {
    b.affectations = [];
    expect((await appel("programme").expect(200)).body).toMatchObject({ lieu: null, actuel: null, prochains: [] });
    await request(app).post("/ingest/v1/evenements/programme").set("Authorization", `Bearer ${genererCle().cle}`).send({ borne_id: "SZ-001" }).expect(401);
    vi.useRealTimers();
  });
});

describe("versions et installations", () => {
  it("version publiée de chaque code ; un code d'un autre lieu ou inconnu : unknown", async () => {
    const r = (await appel("versions", { codes: ["rdef", "RNOE", "RAUT", "RZZZ", "RBRO"] }).expect(200)).body;
    vi.useRealTimers();
    expect(r.evenements).toEqual([
      { code: "RDEF", nom: null, parDefaut: true, version: 3, publieLe: "2026-11-10T09:00:00.000Z", status: "complete" },
      expect.objectContaining({ code: "RNOE", version: 1, status: "complete" }),
      { code: "RAUT", status: "unknown" },
      { code: "RZZZ", status: "unknown" },
      expect.objectContaining({ code: "RBRO", version: 0, status: "incomplete" }),
    ]);
    await appel("versions", { codes: [] }).expect(400);
  });

  it("la borne signale téléchargé / installé / échec ; une valeur inconnue est refusée et journalisée", async () => {
    await appel("installation", { code: "RHAL", version: 1, etat: "INSTALLE" }).expect(200);
    await appel("installation", { code: "RZZZ", version: 2, etat: "ECHEC", message: "sha256 différent" }).expect(200);
    vi.useRealTimers();
    expect(b.installations).toEqual([
      { borneId: 1, configEvenementId: "RHAL".charCodeAt(1), code: "RHAL", version: 1, etat: "INSTALLE", message: null },
      { borneId: 1, configEvenementId: null, code: "RZZZ", version: 2, etat: "ECHEC", message: "sha256 différent" },
    ]);
    await appel("installation", { code: "RHAL", version: 1, etat: "FINI" }).expect(400);
    expect(b.rejets).toHaveLength(1);
  });
});
