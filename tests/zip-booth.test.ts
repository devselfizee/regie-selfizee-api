import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { genererCle } from "../src/lib/cleBorne.js";
import { prisma } from "../src/lib/prisma.js";
import { initialiserReferentiel } from "../src/referentiel/initial.js";
import { viderBase } from "./aide.js";

// Événement booth « sur mesure » (avenant de l'équipe borne du 24/11/2026) : dépôt du zip dans l'onglet Configuration,
// case « sur mesure », téléchargement du dernier zip. Base de test réelle, stockage dans un dossier temporaire.
// Sans Keycloak : X-Dev-Utilisateur désigne l'utilisateur, X-Dev-Droits simule ses droits.

const dossier = mkdtempSync(join(tmpdir(), "zip-booth-"));
process.env.MEDIAS_DIR = dossier;
// 64 Ko au lieu de 100 Mo : de quoi tester le refus sans fabriquer un gros fichier
process.env.ZIP_BOOTH_MAX_OCTETS = String(64 * 1024);
afterAll(() => {
  rmSync(dossier, { recursive: true, force: true });
  delete process.env.ZIP_BOOTH_MAX_OCTETS;
});

const app = creerApp();
const en = (email?: string, droits?: string) => {
  const r = (req: request.Test) => (droits ? req.set("X-Dev-Droits", droits) : req);
  const u = (req: request.Test) => (email ? req.set("X-Dev-Utilisateur", email) : req);
  return {
    get: (url: string) => r(u(request(app).get(url))),
    post: (url: string) => r(u(request(app).post(url))),
    put: (url: string) => r(u(request(app).put(url))),
  };
};
const admin = en();

/** Un zip avec ces fichiers ; config.json porte `code` par défaut. */
async function zip(fichiers: Record<string, string | Buffer>) {
  const z = new JSZip();
  for (const [nom, contenu] of Object.entries(fichiers)) z.file(nom, contenu);
  return z.generateAsync({ type: "nodebuffer" });
}
const config = (code: string) => JSON.stringify({ event: { code, name: "MARIAGE DUPONT" }, pages: [] });
/** Corps binaire de la réponse (supertest le lit en texte sinon). */
const lireBinaire = (res: { on(ev: string, cb: (c: Buffer) => void): unknown }, fin: (err: Error | null, corps: Buffer) => void) => {
  const morceaux: Buffer[] = [];
  res.on("data", (c: Buffer) => morceaux.push(c));
  res.on("end", () => fin(null, Buffer.concat(morceaux)));
};
const fichier = (code: string, version: number) => join(dossier, "evenements-booth", code, `v${version}.zip`);

let lieuA = 0;
let lieuB = 0;
/** Créneau booth d'une nuit (20:00 → 06:00) ; un seul booth à la fois sur un lieu : changer de jour pour un second code. */
const creneau = async (lieuId: number, code: string, jour = "2026-11-28") => {
  const lendemain = new Date(Date.parse(`${jour}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return (await admin.post(`/api/lieux/${lieuId}/evenements-booth`).send({ code, dateDebut: jour, dateFin: lendemain, heureDebut: "20:00", heureFin: "06:00" }).expect(201)).body.id as number;
};
const deposer = (lieuId: number, id: number, corps: Buffer, qui = admin, nom = "FTL6 modifié.zip") =>
  qui.post(`/api/lieux/${lieuId}/evenements-booth/${id}/zip`).set("Content-Type", "application/zip").set("X-Nom-Fichier", encodeURIComponent(nom)).send(corps);

beforeEach(async () => {
  await viderBase();
  await initialiserReferentiel();
  rmSync(join(dossier, "evenements-booth"), { recursive: true, force: true });
  const bar = await prisma.refValeur.findFirstOrThrow({ where: { categorie: "TYPE_LIEU", code: "BAR" } });
  const [a, b] = await Promise.all([
    prisma.user.create({ data: { email: "alice@test.fr", nom: "Martin", prenom: "Alice", role: "COMMERCIAL" } }),
    prisma.user.create({ data: { email: "bob@test.fr", nom: "Durand", prenom: "Bob", role: "COMMERCIAL" } }),
  ]);
  lieuA = (await prisma.lieu.create({ data: { raisonSociale: "A", enseigne: "Le A", typeLieuId: bar.id, commercialId: a.id } })).id;
  lieuB = (await prisma.lieu.create({ data: { raisonSociale: "B", enseigne: "Le B", typeLieuId: bar.id, commercialId: b.id } })).id;
});

describe("dépôt du zip d'un événement booth sur mesure", () => {
  it("contrôle du code, version 1 cochée, fichier rangé ; chaque dépôt ajoute une version ; le zip vaut pour le code, sur tous ses lieux", async () => {
    const id = await creneau(lieuA, "FTL6");
    await creneau(lieuB, "FTL6");
    const v1 = await zip({ "config.json": config("ftl6"), "Backgrounds/fond.jpg": "image" });
    const r = await deposer(lieuA, id, v1).expect(201);
    expect(r.body).toMatchObject({ id, code: "FTL6", autresLieux: 1 });
    expect(r.body.zip).toMatchObject({ actif: true, version: 1, taille: v1.length, nomFichier: "FTL6 modifié.zip", etat: "complete" });
    expect(r.body.zip.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.compare(readFileSync(fichier("FTL6", 1)), v1)).toBe(0);

    await deposer(lieuA, id, await zip({ "config.json": config("FTL6"), "v2.txt": "2" })).expect(201);
    const v3 = await deposer(lieuA, id, await zip({ "config.json": config("FTL6"), "v3.txt": "3" })).expect(201);
    expect(v3.body.zip.version).toBe(3);
    // L'avant-dernière version reste (borne en plein téléchargement), celle d'avant est retirée ; aucun fichier d'attente
    expect([existsSync(fichier("FTL6", 1)), existsSync(fichier("FTL6", 2)), existsSync(fichier("FTL6", 3))]).toEqual([false, true, true]);
    expect(readdirSync(join(dossier, "evenements-booth", "FTL6")).sort()).toEqual(["v2.zip", "v3.zip"]);

    // Le créneau du même code sur l'autre lieu voit le même zip
    const listeB = (await admin.get(`/api/lieux/${lieuB}/evenements-booth`).expect(200)).body;
    expect(listeB[0]).toMatchObject({ code: "FTL6", autresLieux: 1, zip: { actif: true, version: 3 } });
    expect(await prisma.auditLog.count({ where: { entite: "zip_booth", action: "DEPOT" } })).toBe(3);
  });

  it("refus explicites, sans rien enregistrer : pas un zip, config.json absent ou dans un dossier, code différent, trop gros, mauvais type, code Régie", async () => {
    const id = await creneau(lieuA, "AB12");
    const refus = async (corps: Buffer, statut: number, erreur: string) => {
      const r = await deposer(lieuA, id, corps).expect(statut);
      expect(r.body.error).toBe(erreur);
      return r.body.message as string;
    };
    await refus(Buffer.from("pas un zip"), 400, "ZIP_ILLISIBLE");
    await refus(await zip({ "fond.jpg": "image" }), 400, "CONFIG_ABSENT");
    expect(await refus(await zip({ "AB12/config.json": config("AB12") }), 400, "CONFIG_ABSENT")).toContain("racine");
    await refus(await zip({ "config.json": "{ pas du json" }), 400, "CONFIG_ILLISIBLE");
    await refus(await zip({ "config.json": JSON.stringify({ event: {} }) }), 400, "CODE_ABSENT");
    expect(await refus(await zip({ "config.json": config("XY99") }), 400, "CODE_DIFFERENT")).toContain("XY99");
    // Au-delà de la limite (64 Ko ici) : données aléatoires, non compressibles
    const gros = await zip({ "config.json": config("AB12"), "video.mp4": Buffer.from(Array.from({ length: 80_000 }, () => Math.floor(Math.random() * 256))) });
    await refus(gros, 413, "ZIP_TROP_GROS");
    await admin.post(`/api/lieux/${lieuA}/evenements-booth/${id}/zip`).send({ zip: "en json" }).expect(415);

    // Un code qui est aussi celui d'un événement Régie
    const regie = await creneau(lieuA, "RAB1", "2026-12-05");
    await prisma.configEvenement.create({ data: { lieuId: lieuA, habituel: false, nom: "Régie", code: "RAB1", motDePasseTableau: "x", reglages: {} } });
    const r = await deposer(lieuA, regie, await zip({ "config.json": config("RAB1") })).expect(409);
    expect(r.body.error).toBe("CODE_REGIE");

    expect(await prisma.zipBooth.count()).toBe(0);
    const reste = existsSync(join(dossier, "evenements-booth")) ? readdirSync(join(dossier, "evenements-booth"), { recursive: true }) : [];
    expect(reste.filter((f) => String(f).endsWith(".zip"))).toEqual([]);
  });

  it("case sur mesure : cocher sans zip refusé ; décocher puis recocher ressert la même version ; le dépôt suivant prend le numéro d'après", async () => {
    const id = await creneau(lieuA, "CD34");
    const url = `/api/lieux/${lieuA}/evenements-booth/${id}/sur-mesure`;
    expect((await admin.put(url).send({ actif: true }).expect(400)).body.error).toBe("PAS_DE_ZIP");
    await admin.get(`/api/lieux/${lieuA}/evenements-booth/${id}/zip`).expect(404);

    const v1 = await zip({ "config.json": config("CD34") });
    await deposer(lieuA, id, v1).expect(201);
    expect((await admin.put(url).send({ actif: false }).expect(200)).body.zip).toMatchObject({ actif: false, version: 1 });
    expect(await prisma.zipBooth.findUniqueOrThrow({ where: { code: "CD34" } })).toMatchObject({ actif: false, version: 1 });
    expect((await admin.put(url).send({ actif: true }).expect(200)).body.zip).toMatchObject({ actif: true, version: 1 });

    const t = await admin.get(`/api/lieux/${lieuA}/evenements-booth/${id}/zip`).buffer(true).parse((res, fin) => lireBinaire(res, fin)).expect(200);
    expect(t.headers["content-disposition"]).toContain('filename="CD34-v1.zip"');
    expect(Buffer.compare(t.body as Buffer, v1)).toBe(0);

    await admin.put(url).send({ actif: false }).expect(200);
    // Nouveau dépôt après un retrait : version 2 (jamais deux contenus sous le même numéro), case recochée
    expect((await deposer(lieuA, id, await zip({ "config.json": config("CD34"), "v2.txt": "2" })).expect(201)).body.zip).toMatchObject({ actif: true, version: 2 });
    const actions = await prisma.auditLog.findMany({ where: { entite: "zip_booth" }, orderBy: { id: "asc" }, select: { action: true } });
    expect(actions.map((a) => a.action)).toEqual(["DEPOT", "RETRAIT", "ACTIVATION", "RETRAIT", "DEPOT"]);
  });

  it("droits : dépôt et case avec evenements.edit, téléchargement avec evenements.view ; périmètre du commercial", async () => {
    const id = await creneau(lieuA, "EF56");
    const idB = await creneau(lieuB, "EF56");
    const corps = await zip({ "config.json": config("EF56") });
    const lecteur = en("alice@test.fr", "evenements.view");
    const editeur = en("alice@test.fr", "evenements.view,evenements.edit");
    await deposer(lieuA, id, corps, lecteur).expect(403);
    await lecteur.put(`/api/lieux/${lieuA}/evenements-booth/${id}/sur-mesure`).send({ actif: false }).expect(403);
    await deposer(lieuA, id, corps, editeur).expect(201);
    await lecteur.get(`/api/lieux/${lieuA}/evenements-booth/${id}/zip`).expect(200);
    // Le lieu de Bob : hors du périmètre d'Alice
    await deposer(lieuB, idB, corps, editeur).expect(404);
    await editeur.get(`/api/lieux/${lieuB}/evenements-booth/${idB}/zip`).expect(404);
    await en("alice@test.fr", "lieux.view").get(`/api/lieux/${lieuA}/evenements-booth/${id}/zip`).expect(403);
  });
});

describe("côté borne, sur la base réelle", () => {
  it("le zip déposé arrive dans le programme, se demande par statut, se télécharge ; installation avec la vraie version ; décoché : retour à booth", async () => {
    const gamme = await prisma.gamme.create({ data: { code: "ZB_TEST", libelle: "Test" } });
    const k = genererCle();
    const borne = await prisma.borne.create({ data: { identifiant: "SZ-900", gammeId: gamme.id, statut: "INSTALLEE", apiKeyHash: k.hash, apiKeyPrefix: k.prefixe } });
    await prisma.affectationBorne.create({ data: { borneId: borne.id, lieuId: lieuA, debut: new Date("2026-01-01T00:00:00Z") } });
    const borneApi = (chemin: string, corps: Record<string, unknown> = {}) =>
      request(app).post(`/ingest/v1/evenements/${chemin}`).set("Authorization", `Bearer ${k.cle}`).send({ borne_id: "SZ-900", ...corps });
    // Créneau booth de toute la journée d'aujourd'hui (heure de Paris) : il tourne maintenant
    const aujourdhui = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(new Date());
    const id = (await admin.post(`/api/lieux/${lieuA}/evenements-booth`).send({ code: "GH78", nom: "Mariage", dateDebut: aujourdhui, dateFin: aujourdhui }).expect(201)).body.id;
    expect((await borneApi("programme").expect(200)).body.actuel).toMatchObject({ code: "GH78", origine: "booth", version: 0, publieLe: null });

    const corps = await zip({ "config.json": config("GH78"), "Backgrounds/fond.jpg": "image" });
    await deposer(lieuA, id, corps).expect(201);
    expect((await borneApi("programme").expect(200)).body.actuel).toMatchObject({ code: "GH78", origine: "booth", nom: "Mariage", version: 1, status: "complete" });
    const s = (await borneApi("statut", { code: "GH78" }).expect(200)).body;
    expect(s).toMatchObject({ status: "complete", code: "GH78", version: 1, taille: corps.length });
    const t = await request(app).get((s.url as string).replace(/^https?:\/\/[^/]+/, "")).buffer(true).parse((res, fin) => lireBinaire(res, fin)).expect(200);
    expect(Buffer.compare(t.body as Buffer, corps)).toBe(0);
    await borneApi("installation", { code: "GH78", version: 1, etat: "INSTALLE" }).expect(200);

    const inst = (await admin.get(`/api/lieux/${lieuA}/evenements/installations`).expect(200)).body;
    expect(inst.bornes).toEqual([{ id: borne.id, identifiant: "SZ-900", logicielVersion: null }]);
    expect(inst.parCode.GH78[borne.id]).toMatchObject({ dernier: { etat: "INSTALLE", version: 1 }, installe: { version: 1 } });

    await admin.put(`/api/lieux/${lieuA}/evenements-booth/${id}/sur-mesure`).send({ actif: false }).expect(200);
    expect((await borneApi("programme").expect(200)).body.actuel).toMatchObject({ code: "GH78", version: 0, publieLe: null, status: "complete" });
    expect((await borneApi("statut", { code: "GH78" }).expect(200)).body).toEqual({ status: "unknown" });
  });
});
