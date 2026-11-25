import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { genererCle } from "../src/lib/cleBorne.js";
import { reglagesParDefaut } from "../src/config-evenement/reglages.js";
import { empreinteZip, rangerZip } from "../src/config-evenement/zipBorne.js";
import { cheminZipBooth } from "../src/config-evenement/zipBooth.js";
import { ecrireBuffer, supprimer } from "../src/lib/stockage.js";
import { createHash } from "node:crypto";

// Mise à jour automatique des événements sur la borne : programme (événement à faire tourner maintenant et prochains),
// versions de plusieurs codes, signalement des installations. Base simulée, stockage dans un dossier temporaire.

const b = vi.hoisted(() => ({
  borne: null as null | Record<string, unknown>,
  affectations: [] as { borneId: number; lieuId: number; debut: Date; fin: Date | null }[],
  evenements: [] as Record<string, unknown>[],
  booth: [] as Record<string, unknown>[],
  zips: [] as Record<string, unknown>[],
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
      evenementBooth: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => b.booth.filter((e) => correspond(e, where)),
        findFirst: async ({ where }: { where: Record<string, unknown> }) => b.booth.find((e) => correspond(e, where)) ?? null,
      },
      zipBooth: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => b.zips.filter((z) => correspond(z, where)),
        findUnique: async ({ where }: { where: { code: string } }) => b.zips.find((z) => z.code === where.code) ?? null,
      },
      installationEvenement: {
        create: async ({ data }: { data: Record<string, unknown> }) => b.installations.push({ id: BigInt(b.installations.length + 1), createdAt: new Date(), ...data }),
        // Dernière demande de la borne pour ce code (déclencheur repris par les signalements)
        findFirst: async ({ where }: { where: { borneId: number; code: string } }) =>
          [...b.installations].reverse().find((l) => l.borneId === where.borneId && l.code === where.code && l.declencheur) ?? null,
        findMany: async ({ where, take }: { where: { id?: { lt: bigint }; declencheur?: string; borneId?: number }; take: number }) =>
          [...b.installations]
            .reverse()
            .filter((l) => (!where.id || (l.id as bigint) < where.id.lt) && (!where.declencheur || l.declencheur === where.declencheur) && (!where.borneId || l.borneId === where.borneId))
            .slice(0, take)
            .map((l) => ({ ...l, borne: { id: 1, identifiant: "SZ-001" }, evenement: l.configEvenementId ? { id: l.configEvenementId, nom: "Halloween", habituel: false, lieu: { id: 7, enseigne: "La Ruche", ville: "Trégueux" } } : null })),
      },
      user: { upsert: async () => ({ id: 1, email: "dev@local", nom: "Dev", prenom: "", role: "ADMIN", lieuId: null, isActive: true }) },
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

/** Créneau booth programmé sur le lieu : seulement un code et des dates (avenant du 18/11/2026). */
function booth(code: string, d: { nom?: string; debut: string; fin?: string; hDebut?: string | null; hFin?: string | null; lieuId?: number }) {
  return { id: code.charCodeAt(0) * 100 + code.charCodeAt(1), lieuId: d.lieuId ?? 7, code, nom: d.nom ?? null, dateDebut: new Date(`${d.debut}T00:00:00Z`), dateFin: new Date(`${d.fin ?? d.debut}T00:00:00Z`), heureDebut: d.hDebut ?? null, heureFin: d.hFin ?? null };
}

/** Zip déposé pour un code booth (événement sur mesure, avenant du 24/11/2026), rangé dans le stockage. */
async function zipBooth(code: string, d: { version: number; actif?: boolean }) {
  await ecrireBuffer(cheminZipBooth(code, d.version), ZIP);
  return {
    code, version: d.version, actif: d.actif ?? true, publieeLe: new Date("2026-11-12T10:12:00Z"),
    zipChemin: cheminZipBooth(code, d.version), zipTaille: ZIP.length, zipSha256: createHash("sha256").update(ZIP).digest("hex"),
  };
}
/** Corps binaire de la réponse (supertest le lit en texte sinon). */
const lireBinaire = (res: { on(ev: string, cb: (c: Buffer) => void): unknown }, fin: (err: Error | null, corps: Buffer) => void) => {
  const morceaux: Buffer[] = [];
  res.on("data", (c: Buffer) => morceaux.push(c));
  res.on("end", () => fin(null, Buffer.concat(morceaux)));
};

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
  b.booth = [];
  b.zips = [];
  b.installations = [];
  b.rejets = [];
  for (const e of b.evenements) if (e.zipChemin) await rangerZip(String(e.code), Number(e.version), ZIP);
});

describe("programme de la borne", () => {
  it("l'événement personnalisé en cours, jusqu'à sa fin ; les prochains sur 14 jours, prêts ou non", async () => {
    const r = (await appel("programme").expect(200)).body;
    expect(r.lieu).toEqual({ id: 7, nom: "La Ruche" });
    expect(r.maintenant).toBe("2026-11-13T15:00:00.000+01:00");
    expect(r.actuel).toMatchObject({ code: "RHAL", origine: "regie", nom: "Halloween", parDefaut: false, version: 1, status: "complete", jusqua: "2026-11-15T00:00:00.000+01:00" });
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

  it("créneau booth en cours : transmis tel quel, origine booth, version 0, complete, sans zip", async () => {
    b.evenements = b.evenements.filter((e) => e.code !== "RHAL");
    b.booth = [booth("AB12", { nom: "Soirée privée", debut: "2026-11-13", hDebut: "14:00", hFin: "23:00" }), booth("ZZ99", { debut: "2026-11-25", lieuId: 9 })];
    const r = (await appel("programme").expect(200)).body;
    vi.useRealTimers();
    expect(r.actuel).toEqual({ code: "AB12", origine: "booth", nom: "Soirée privée", parDefaut: false, version: 0, publieLe: null, status: "complete", jusqua: "2026-11-13T23:00:00.000+01:00" });
    // Le créneau d'un autre lieu n'est pas dans les prochains
    expect(r.prochains.map((p: { code: string }) => p.code)).toEqual(["RBRO", "RNOE"]);
    expect(r.prochains.every((p: { origine: string }) => p.origine === "regie")).toBe(true);
  });

  it("booth et Régie qui se chevauchent : celui qui a commencé le plus tard ; booth à venir dans les prochains", async () => {
    // Halloween a commencé le 12, le booth le 13 à 10 h : le booth l'emporte jusqu'à sa fin, puis Halloween reprend
    b.booth = [booth("AB12", { debut: "2026-11-13", hDebut: "10:00", hFin: "18:00" }), booth("CD34", { nom: "Mariage", debut: "2026-11-21", fin: "2026-11-22" })];
    const r = (await appel("programme").expect(200)).body;
    vi.useRealTimers();
    expect(r.actuel).toMatchObject({ code: "AB12", origine: "booth", nom: null, version: 0, status: "complete", jusqua: "2026-11-13T18:00:00.000+01:00" });
    expect(r.prochains.map((p: { code: string; origine: string }) => [p.code, p.origine])).toEqual([["RBRO", "regie"], ["RNOE", "regie"], ["CD34", "booth"]]);
    expect(r.prochains[2]).toMatchObject({ nom: "Mariage", version: 0, publieLe: null, status: "complete", debut: "2026-11-21T00:00:00.000+01:00", fin: "2026-11-23T00:00:00.000+01:00" });
  });

  it("le par défaut tourne jusqu'au prochain créneau booth ; versions et statut ignorent un code booth (unknown)", async () => {
    b.evenements = b.evenements.filter((e) => e.code !== "RHAL");
    b.booth = [booth("AB12", { debut: "2026-11-14", hDebut: "19:00" })];
    const r = (await appel("programme").expect(200)).body;
    expect(r.actuel).toMatchObject({ code: "RDEF", origine: "regie", parDefaut: true, jusqua: "2026-11-14T19:00:00.000+01:00" });
    const v = (await appel("versions", { codes: ["AB12", "RDEF"] }).expect(200)).body;
    expect(v.evenements).toEqual([{ code: "AB12", status: "unknown" }, expect.objectContaining({ code: "RDEF", origine: "regie", version: 3 })]);
    expect((await appel("statut", { code: "AB12" }).expect(200)).body).toEqual({ status: "unknown" });
    vi.useRealTimers();
  });

  it("borne non affectée : ni lieu ni événement ; clé fausse : 401", async () => {
    b.affectations = [];
    expect((await appel("programme").expect(200)).body).toMatchObject({ lieu: null, actuel: null, prochains: [] });
    await request(app).post("/ingest/v1/evenements/programme").set("Authorization", `Bearer ${genererCle().cle}`).send({ borne_id: "SZ-001" }).expect(401);
    vi.useRealTimers();
  });
});

describe("événement booth sur mesure : zip déposé dans la Régie (avenant du 24/11/2026)", () => {
  it("programme : la version du dernier dépôt si la case est cochée, 0 sinon ; zip disparu : pas prêt, le par défaut tourne", async () => {
    b.evenements = b.evenements.filter((e) => e.code !== "RHAL");
    b.booth = [booth("FTL6", { nom: "Mariage Dupont", debut: "2026-11-13", hDebut: "14:00", hFin: "23:00" }), booth("CD34", { debut: "2026-11-21" })];
    b.zips = [await zipBooth("FTL6", { version: 2 }), await zipBooth("CD34", { version: 1, actif: false })];
    const r = (await appel("programme").expect(200)).body;
    expect(r.actuel).toEqual({
      code: "FTL6", origine: "booth", nom: "Mariage Dupont", parDefaut: false, version: 2, publieLe: "2026-11-12T10:12:00.000Z", status: "complete",
      jusqua: "2026-11-13T23:00:00.000+01:00",
    });
    // Case décochée : version 0, la borne reprend booth
    expect(r.prochains.find((p: { code: string }) => p.code === "CD34")).toMatchObject({ origine: "booth", version: 0, publieLe: null, status: "complete" });

    await supprimer(cheminZipBooth("FTL6", 2));
    const r2 = (await appel("programme").expect(200)).body;
    vi.useRealTimers();
    expect(r2.actuel).toMatchObject({ code: "RDEF", parDefaut: true, jusqua: "2026-11-20T20:00:00.000+01:00" });
  });

  it("statut : comme un événement Régie, sur une URL signée propre au booth ; téléchargement, reprise, journal avec la vraie version", async () => {
    b.booth = [booth("FTL6", { debut: "2026-11-13" })];
    b.zips = [await zipBooth("FTL6", { version: 2 })];
    const s = (await appel("statut", { code: "ftl6" }).expect(200)).body;
    expect(s).toMatchObject({ status: "complete", code: "FTL6", version: 2, publieLe: "2026-11-12T10:12:00.000Z", taille: ZIP.length, sha256: b.zips[0].zipSha256 });
    expect(s.url).toMatch(/\/ingest\/v1\/evenements\/booth\/FTL6\/zip\?v=2&exp=\d+&b=1&d=m&sig=[\w-]+$/);
    const chemin = (s.url as string).replace(/^https?:\/\/[^/]+/, "");

    const z = await request(app).get(chemin).buffer(true).parse((res, fin) => lireBinaire(res, fin)).expect(200);
    expect(z.headers["content-type"]).toBe("application/zip");
    expect(z.headers["x-zip-sha256"]).toBe(b.zips[0].zipSha256);
    expect(Buffer.compare(z.body as Buffer, ZIP)).toBe(0);
    await request(app).get(chemin).set("Range", "bytes=4-7").expect(206);
    // La signature vaut pour la route booth seulement
    await request(app).get(chemin.replace("/evenements/booth/", "/evenements/")).expect(404);

    await appel("installation", { code: "FTL6", version: 2, etat: "INSTALLE" }).expect(200);
    vi.useRealTimers();
    expect(b.installations.map((l) => [l.code, l.version, l.etat, l.lieuId, l.configEvenementId])).toEqual([
      ["FTL6", 2, "DEMANDE", 7, null],
      ["FTL6", 2, "ENVOYE", 7, null],
      ["FTL6", 2, "INSTALLE", 7, null],
    ]);
  });

  it("versions donne la version servie ; case décochée, ou code programmé sur un autre lieu seulement : unknown", async () => {
    b.booth = [booth("FTL6", { nom: "Mariage", debut: "2026-11-13" }), booth("GH56", { debut: "2026-11-13", lieuId: 9 })];
    b.zips = [await zipBooth("FTL6", { version: 3 }), await zipBooth("GH56", { version: 1 })];
    const v = (await appel("versions", { codes: ["FTL6", "GH56"] }).expect(200)).body;
    expect(v.evenements).toEqual([
      { code: "FTL6", origine: "booth", nom: "Mariage", parDefaut: false, version: 3, publieLe: "2026-11-12T10:12:00.000Z", status: "complete" },
      { code: "GH56", status: "unknown" },
    ]);
    expect((await appel("statut", { code: "GH56" }).expect(200)).body).toEqual({ status: "unknown" });

    b.zips[0].actif = false;
    expect((await appel("versions", { codes: ["FTL6"] }).expect(200)).body.evenements).toEqual([{ code: "FTL6", status: "unknown" }]);
    expect((await appel("statut", { code: "FTL6" }).expect(200)).body).toEqual({ status: "unknown" });
    vi.useRealTimers();
  });
});

describe("versions et installations", () => {
  it("version publiée de chaque code ; un code d'un autre lieu ou inconnu : unknown", async () => {
    const r = (await appel("versions", { codes: ["rdef", "RNOE", "RAUT", "RZZZ", "RBRO"] }).expect(200)).body;
    vi.useRealTimers();
    expect(r.evenements).toEqual([
      { code: "RDEF", origine: "regie", nom: null, parDefaut: true, version: 3, publieLe: "2026-11-10T09:00:00.000Z", status: "complete" },
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
      expect.objectContaining({ borneId: 1, configEvenementId: "RHAL".charCodeAt(1), lieuId: 7, code: "RHAL", version: 1, etat: "INSTALLE", declencheur: null, message: null }),
      expect.objectContaining({ borneId: 1, configEvenementId: null, lieuId: null, code: "RZZZ", version: 2, etat: "ECHEC", message: "sha256 différent" }),
    ]);
    await appel("installation", { code: "RHAL", version: 1, etat: "FINI" }).expect(400);
    expect(b.rejets).toHaveLength(1);
  });

  it("installation d'un code booth en version 0 : acceptée, rattachée au lieu si le créneau y est programmé", async () => {
    b.booth = [booth("AB12", { debut: "2026-11-13" })];
    await appel("installation", { code: "ab12", version: 0, etat: "INSTALLE", declencheur: "auto" }).expect(200);
    await appel("installation", { code: "XX77", version: 0, etat: "ECHEC", message: "BadEventCode" }).expect(200);
    vi.useRealTimers();
    expect(b.installations).toEqual([
      expect.objectContaining({ borneId: 1, configEvenementId: null, lieuId: 7, code: "AB12", version: 0, etat: "INSTALLE", declencheur: "AUTO" }),
      expect.objectContaining({ borneId: 1, configEvenementId: null, lieuId: null, code: "XX77", version: 0, etat: "ECHEC", message: "BadEventCode" }),
    ]);
  });
});

describe("journal des téléchargements", () => {
  it("auto si le code vient du programme de la borne, manuel sinon ; la borne peut aussi le dire ; les signalements suivent", async () => {
    await appel("statut", { code: "ROLD" }).expect(200); // code que le programme n'annonce pas : tapé à la main
    await appel("programme").expect(200);
    await appel("statut", { code: "RNOE" }).expect(200); // annoncé par le programme : mise à jour automatique
    await appel("statut", { code: "RNOE", declencheur: "manuel" }).expect(200);
    await appel("installation", { code: "RNOE", version: 1, etat: "TELECHARGE" }).expect(200); // suit la dernière demande
    await appel("installation", { code: "RNOE", version: 1, etat: "INSTALLE", declencheur: "auto" }).expect(200);
    await appel("statut", { code: "RBRO" }).expect(200); // zip pas prêt : rien au journal
    vi.useRealTimers();
    expect(b.installations.map((l) => [l.etat, l.declencheur])).toEqual([
      ["DEMANDE", "MANUEL"], ["DEMANDE", "AUTO"], ["DEMANDE", "MANUEL"], ["TELECHARGE", "MANUEL"], ["INSTALLE", "AUTO"],
    ]);
  });

  it("lecture par curseur, de la plus récente à la plus ancienne, filtrée par déclencheur", async () => {
    delete process.env.KEYCLOAK_URL;
    for (let n = 0; n < 5; n++) await appel("installation", { code: "RHAL", version: 1, etat: "INSTALLE", declencheur: n % 2 ? "auto" : "manuel" }).expect(200);
    vi.useRealTimers();
    const p1 = (await request(app).get("/api/telechargements-evenements?limite=2").expect(200)).body;
    expect(p1.lignes.map((l: { id: string }) => l.id)).toEqual(["5", "4"]);
    expect(p1.lignes[0]).toMatchObject({ code: "RHAL", version: 1, etat: "INSTALLE", declencheur: "MANUEL", borne: { identifiant: "SZ-001" }, lieu: { enseigne: "La Ruche" }, evenement: { nom: "Halloween", parDefaut: false } });
    expect(p1.suivant).toBe("4");
    const p2 = (await request(app).get(`/api/telechargements-evenements?limite=2&avant=${p1.suivant}`).expect(200)).body;
    expect(p2.lignes.map((l: { id: string }) => l.id)).toEqual(["3", "2"]);
    const fin = (await request(app).get("/api/telechargements-evenements?limite=2&avant=2").expect(200)).body;
    expect(fin).toMatchObject({ suivant: null });
    const autos = (await request(app).get("/api/telechargements-evenements?declencheur=AUTO").expect(200)).body;
    expect(autos.lignes.map((l: { id: string }) => l.id)).toEqual(["4", "2"]);
  });
});
