import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { ecrireBuffer } from "../src/lib/stockage.js";
import { initialiserReferentiel } from "../src/referentiel/initial.js";
import { viderBase } from "./aide.js";

// Galerie des médias PikCloud : liste par lieu et événement, filtres, droits par rôle, fichiers servis derrière le jeton.
const app = creerApp();
const en = (email: string | null) => ({
  post: (url: string) => (email ? request(app).post(url).set("X-Dev-Utilisateur", email) : request(app).post(url)),
  get: (url: string) => (email ? request(app).get(url).set("X-Dev-Utilisateur", email) : request(app).get(url)),
});
const admin = en(null);
const alice = en("alice@test.fr");
const bob = en("bob@test.fr");
const paul = en("paul@test.fr");
const tech = en("tech@test.fr");

let dossier: string;
let photoJpeg: Buffer;
let vignetteJpeg: Buffer;
const video = Buffer.alloc(2048, 9);
let lieuA: number;
let lieuB: number;
let evtA: number;
let evtAPonctuel: number;
const ids: Record<string, string> = {}; // nom → uuid

beforeAll(async () => {
  dossier = await mkdtemp(join(tmpdir(), "regie-galerie-"));
  process.env.MEDIAS_DIR = dossier;
  photoJpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
  vignetteJpeg = await sharp(photoJpeg).resize({ width: 480 }).jpeg().toBuffer();
});
afterAll(async () => {
  await rm(dossier, { recursive: true, force: true });
  await prisma.$disconnect();
});

type Fichier = "image" | "video" | "aucun";
async function media(nom: string, o: { lieuId: number | null; evtId: number | null; code: string; type: string; datePhoto: string | null; fichier?: Fichier; test?: boolean; photoUuid?: string; nbTirages?: number }) {
  const lot = await prisma.importLot.create({ data: { source: "API", type: "MEDIAS", payloadSha256: "0".repeat(64), payload: {}, statut: "OK" } });
  const m = await prisma.media.create({
    data: {
      codeEvent: o.code,
      filename: `2026_11_01_00_00_00_${nom}`,
      configEvenementId: o.evtId,
      lieuId: o.lieuId,
      borneIdentifiant: "S12",
      typeMedia: o.type,
      importId: lot.id,
      test: o.test ?? false,
      photoUuid: o.photoUuid ?? null,
      datePhoto: o.datePhoto ? new Date(o.datePhoto) : null,
      nbTirages: o.nbTirages ?? null,
      dataStatut: o.datePhoto ? "TELECHARGE" : "A_TELECHARGER",
      mediaStatut: (o.fichier ?? "image") === "aucun" ? "A_TELECHARGER" : "TELECHARGE",
    },
  });
  const fichier = o.fichier ?? "image";
  if (fichier !== "aucun") {
    const d = m.uuid.slice(0, 2);
    const chemin = fichier === "video" ? `${d}/${m.uuid}.mp4` : `${d}/${m.uuid}.jpg`;
    await ecrireBuffer(chemin, fichier === "video" ? video : photoJpeg);
    let vignetteChemin: string | null = null;
    if (fichier === "image") {
      vignetteChemin = `${d}/${m.uuid}.vignette.jpg`;
      await ecrireBuffer(vignetteChemin, vignetteJpeg);
    }
    await prisma.media.update({ where: { id: m.id }, data: { mediaChemin: chemin, vignetteChemin, tailleOctets: fichier === "video" ? video.length : photoJpeg.length, telechargeLe: new Date() } });
  }
  ids[nom] = m.uuid;
  return m;
}

beforeEach(async () => {
  await viderBase();
  await initialiserReferentiel();
  const bar = await prisma.refValeur.findFirstOrThrow({ where: { categorie: "TYPE_LIEU", code: "BAR" } });
  const [a, b] = await Promise.all([
    prisma.user.create({ data: { email: "alice@test.fr", nom: "Martin", prenom: "Alice", role: "COMMERCIAL" } }),
    prisma.user.create({ data: { email: "bob@test.fr", nom: "Durand", prenom: "Bob", role: "COMMERCIAL" } }),
    prisma.user.create({ data: { email: "tech@test.fr", nom: "Tech", prenom: "T", role: "TECHNICIEN" } }),
  ]);
  lieuA = (await prisma.lieu.create({ data: { raisonSociale: "A", enseigne: "Le A", typeLieuId: bar.id, commercialId: a.id } })).id;
  lieuB = (await prisma.lieu.create({ data: { raisonSociale: "B", enseigne: "Le B", typeLieuId: bar.id, commercialId: b.id } })).id;
  await prisma.user.create({ data: { email: "paul@test.fr", nom: "Partenaire", prenom: "Paul", role: "PARTENAIRE", lieuId: lieuA } });
  evtA = (await prisma.configEvenement.create({ data: { lieuId: lieuA, code: "RAAA", motDePasseTableau: "1", reglages: {} } })).id;
  evtAPonctuel = (await prisma.configEvenement.create({ data: { lieuId: lieuA, habituel: false, nom: "Halloween", code: "RAAB", motDePasseTableau: "1", reglages: {} } })).id;
  const evtB = (await prisma.configEvenement.create({ data: { lieuId: lieuB, code: "RBBB", motDePasseTableau: "1", reglages: {} } })).id;

  await media("photo1", { lieuId: lieuA, evtId: evtA, code: "RAAA", type: "photo", datePhoto: "2026-11-04T21:00:00Z", photoUuid: "3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53", nbTirages: 2 });
  await media("multi2", { lieuId: lieuA, evtId: evtAPonctuel, code: "RAAB", type: "multipose", datePhoto: "2026-11-05T21:00:00Z" });
  await media("video3", { lieuId: lieuA, evtId: evtA, code: "RAAA", type: "video", datePhoto: "2026-11-01T21:00:00Z", fichier: "video" });
  await media("test4", { lieuId: lieuA, evtId: evtA, code: "RAAA", type: "photo", datePhoto: "2026-11-03T21:00:00Z", test: true });
  await media("attente5", { lieuId: lieuA, evtId: evtA, code: "RAAA", type: "photo", datePhoto: null, fichier: "aucun" });
  await media("b6", { lieuId: lieuB, evtId: evtB, code: "RBBB", type: "photo", datePhoto: "2026-11-02T21:00:00Z" });
  await media("sanslieu7", { lieuId: null, evtId: null, code: "RZZZ", type: "photo", datePhoto: "2026-11-02T21:00:00Z" });

  // La vente de photo1 (même photo_uuid), envoyée par la borne
  const gamme = await prisma.gamme.findUniqueOrThrow({ where: { code: "SPHERIK" } });
  const borne = await prisma.borne.create({ data: { identifiant: "S12", gammeId: gamme.id } });
  const typeModule = await prisma.typeModulePaiement.findFirstOrThrow();
  const lot = await prisma.importLot.create({ data: { source: "API", type: "TRANSACTIONS", payloadSha256: "1".repeat(64), payload: {}, statut: "OK" } });
  await prisma.transaction.create({
    data: {
      borneId: borne.id, transactionIdModule: "T1", lieuId: lieuA, horodatage: new Date("2026-11-04T21:01:00Z"), offsetMinutes: 60, jourLocal: new Date("2026-11-04T00:00:00Z"),
      montantTtcCents: 500, tauxTvaBp: 2000, montantHtCents: 417, statut: "ACCEPTEE", typeModuleId: typeModule.id, moyenPaiement: "CB",
      pikcloudUuid: "3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53", produitCode: "PHOTO", nbTirages: 2, logicielVersion: "1.9.5", importId: lot.id,
    },
  });
});

const noms = (r: { body: { medias: { uuid: string }[] } }) => r.body.medias.map((m) => Object.entries(ids).find(([, u]) => u === m.uuid)?.[0]);

describe("galerie : liste du lieu", () => {
  it("renvoie les médias du lieu, les plus récents d'abord, séances de test exclues, vignettes en data URL", async () => {
    const r = await admin.get(`/api/lieux/${lieuA}/medias`).expect(200);
    expect(r.body).toMatchObject({ total: 4, page: 1, parPage: 48 });
    // Sans date (JSON pas encore reçu) en tête, puis par date de prise de vue décroissante
    expect(noms(r)).toEqual(["attente5", "multi2", "photo1", "video3"]);
    const [attente, multi, photo, video] = r.body.medias;
    expect(attente).toMatchObject({ statut: "A_TELECHARGER", vignette: null, jsonRecu: false, datePhoto: null });
    expect(multi.evenement).toMatchObject({ id: evtAPonctuel, code: "RAAB", nom: "Halloween", habituel: false });
    expect(photo).toMatchObject({ type: "photo", video: false, extension: "jpg", nbTirages: 2, test: false, statut: "TELECHARGE", jsonRecu: true, borne: "S12" });
    expect(photo.vignette).toMatch(/^data:image\/jpeg;base64,/);
    expect(video).toMatchObject({ type: "video", video: true, extension: "mp4", vignette: null, taille: 2048 });
  });

  it("filtre par événement, type, période, séances de test, et pagine", async () => {
    expect(noms(await admin.get(`/api/lieux/${lieuA}/medias?evenement=${evtAPonctuel}`).expect(200))).toEqual(["multi2"]);
    expect(noms(await admin.get(`/api/lieux/${lieuA}/medias?type=video`).expect(200))).toEqual(["video3"]);
    // Jours locaux Paris : le 04/11 à 22 h Paris = 21 h UTC
    expect(noms(await admin.get(`/api/lieux/${lieuA}/medias?du=2026-11-04`).expect(200))).toEqual(["multi2", "photo1"]);
    expect(noms(await admin.get(`/api/lieux/${lieuA}/medias?au=2026-11-04`).expect(200))).toEqual(["photo1", "video3"]);
    expect(noms(await admin.get(`/api/lieux/${lieuA}/medias?du=2026-11-04&au=2026-11-04`).expect(200))).toEqual(["photo1"]);
    expect((await admin.get(`/api/lieux/${lieuA}/medias?tests=1`).expect(200)).body.total).toBe(5);
    const p2 = await admin.get(`/api/lieux/${lieuA}/medias?parPage=3&page=2`).expect(200);
    expect(p2.body).toMatchObject({ total: 4, page: 2, parPage: 3 });
    expect(noms(p2)).toEqual(["video3"]);
    await admin.get(`/api/lieux/${lieuA}/medias?du=hier`).expect(400);
  });

  it("résumé : compteurs par événement (tous les événements du lieu) et par type", async () => {
    const r = await admin.get(`/api/lieux/${lieuA}/medias/resume`).expect(200);
    expect(r.body.total).toBe(4);
    expect(r.body.derniere).toBe("2026-11-05T21:00:00.000Z");
    expect(r.body.parEvenement).toEqual([
      { id: evtA, code: "RAAA", nom: null, habituel: true, total: 3 },
      { id: evtAPonctuel, code: "RAAB", nom: "Halloween", habituel: false, total: 1 },
    ]);
    expect(r.body.parType).toEqual([
      { type: "photo", total: 2 },
      { type: "multipose", total: 1 },
      { type: "video", total: 1 },
    ]);
  });
});

describe("galerie : droits", () => {
  it("commercial : ses lieux seulement ; partenaire : son lieu ; technicien : rien", async () => {
    expect((await alice.get(`/api/lieux/${lieuA}/medias`).expect(200)).body.total).toBe(4);
    await alice.get(`/api/lieux/${lieuB}/medias`).expect(404);
    await alice.get(`/api/lieux/${lieuB}/medias/resume`).expect(404);
    expect((await bob.get(`/api/lieux/${lieuB}/medias`).expect(200)).body.total).toBe(1);
    expect((await paul.get(`/api/lieux/${lieuA}/medias`).expect(200)).body.total).toBe(4);
    await paul.get(`/api/lieux/${lieuB}/medias`).expect(404);
    await tech.get(`/api/lieux/${lieuA}/medias`).expect(403);
    await tech.get(`/api/medias/${ids.photo1}/fichier`).expect(403);
  });

  it("un média : visible par ceux qui voient son lieu ; sans lieu, par l'admin seulement", async () => {
    await alice.get(`/api/medias/${ids.photo1}`).expect(200);
    await bob.get(`/api/medias/${ids.photo1}`).expect(404);
    await bob.get(`/api/medias/${ids.photo1}/fichier`).expect(404);
    await admin.get(`/api/medias/${ids.sanslieu7}`).expect(200);
    await alice.get(`/api/medias/${ids.sanslieu7}`).expect(404);
    await admin.get(`/api/medias/pas-un-uuid`).expect(404);
    await admin.get(`/api/medias/00000000-0000-4000-8000-000000000000`).expect(404);
  });
});

describe("galerie : un média", () => {
  it("détail : la séance, sa vente par photo_uuid, pas de parcours", async () => {
    const r = await admin.get(`/api/medias/${ids.photo1}`).expect(200);
    expect(r.body).toMatchObject({ codeEvent: "RAAA", type: "photo", photoUuid: "3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53", lieuId: lieuA, nbTirages: 2 });
    expect(r.body.vente).toMatchObject({ montantTtcCents: 500, statut: "ACCEPTEE", moyenPaiement: "CB", nbTirages: 2 });
    expect(r.body.parcours).toBeNull();
    // Page souvenir : base du QR (défaut sans SOUVENIR_QR_BASE_URL) + code d'événement + photo_uuid
    expect(r.body.pageSouvenir).toBe("https://myevent.selfizee.fr/p/RAAA3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53");
    expect((await admin.get(`/api/medias/${ids.attente5}`).expect(200)).body.pageSouvenir).toBeNull();
    expect((await admin.get(`/api/medias/${ids.multi2}`).expect(200)).body.vente).toBeNull();
  });

  it("sert le fichier et la vignette derrière le jeton, en ligne ou en téléchargement", async () => {
    const f = await admin.get(`/api/medias/${ids.photo1}/fichier`).expect(200);
    expect(f.headers["content-type"]).toBe("image/jpeg");
    expect(f.headers["content-length"]).toBe(String(photoJpeg.length));
    expect(f.headers["content-disposition"]).toBe('inline; filename="RAAA-2026_11_01_00_00_00_photo1.jpg"');
    expect(Buffer.from(f.body).equals(photoJpeg)).toBe(true);

    const t = await admin.get(`/api/medias/${ids.photo1}/fichier?telecharger=1`).expect(200);
    expect(t.headers["content-disposition"]).toMatch(/^attachment; /);

    // Avec le nom donné par PikCloud, c'est lui qui sert, préfixé du code d'événement
    await prisma.media.update({ where: { uuid: ids.photo1 }, data: { nomFichier: "2026_11_01_00_00_00_photo1.jpg" } });
    const n = await admin.get(`/api/medias/${ids.photo1}/fichier`).expect(200);
    expect(n.headers["content-disposition"]).toBe('inline; filename="RAAA-2026_11_01_00_00_00_photo1.jpg"');
    expect((await admin.get(`/api/medias/${ids.photo1}`).expect(200)).body.nomFichier).toBe("2026_11_01_00_00_00_photo1.jpg");

    const v = await admin.get(`/api/medias/${ids.photo1}/vignette`).expect(200);
    expect(v.headers["content-type"]).toBe("image/jpeg");
    expect(Buffer.from(v.body).equals(vignetteJpeg)).toBe(true);

    const vid = await admin.get(`/api/medias/${ids.video3}/fichier`).expect(200);
    expect(vid.headers["content-type"]).toBe("video/mp4");
    await admin.get(`/api/medias/${ids.video3}/vignette`).expect(404);
  });

  it("média pas encore téléchargé : 404 FICHIER_ABSENT, la ligne reste listée", async () => {
    const r = await admin.get(`/api/medias/${ids.attente5}/fichier`).expect(404);
    expect(r.body.error).toBe("FICHIER_ABSENT");
    expect((await admin.get(`/api/medias/${ids.attente5}`).expect(200)).body.statut).toBe("A_TELECHARGER");
  });
});

describe("galerie : relance des téléchargements", () => {
  it("remet en attente les fichiers en erreur d'un média, puis de tout le lieu ; admin seulement", async () => {
    await prisma.media.update({ where: { uuid: ids.attente5 }, data: { mediaUrl: "https://apidev.pikcloud.io/x.jpg", mediaStatut: "ERREUR", tentatives: 5, derniereErreur: "HTTP 404" } });
    await prisma.media.update({ where: { uuid: ids.photo1 }, data: { dataUrl: "https://apidev.pikcloud.io/x.json", dataStatut: "ERREUR", tentatives: 5 } });

    const resume = await admin.get(`/api/lieux/${lieuA}/medias/resume`).expect(200);
    // attente5 : média en erreur, et son JSON toujours en attente
    expect(resume.body).toMatchObject({ enAttente: 1, enErreur: 2 });

    await alice.post(`/api/medias/${ids.attente5}/relancer`).expect(403);
    const r = await admin.post(`/api/medias/${ids.attente5}/relancer`).expect(200);
    expect(r.body.relances).toBe(1);
    expect(r.body.media).toMatchObject({ statut: "A_TELECHARGER" });
    expect(await prisma.media.findUniqueOrThrow({ where: { uuid: ids.attente5 } })).toMatchObject({ mediaStatut: "A_TELECHARGER", tentatives: 0, derniereErreur: null });

    // Un média déjà reçu n'est pas touché
    expect((await admin.post(`/api/medias/${ids.multi2}/relancer`).expect(200)).body.relances).toBe(0);

    await alice.post(`/api/lieux/${lieuA}/medias/relancer`).expect(403);
    expect((await admin.post(`/api/lieux/${lieuA}/medias/relancer`).expect(200)).body.relances).toBe(2);
    expect(await prisma.media.findUniqueOrThrow({ where: { uuid: ids.photo1 } })).toMatchObject({ dataStatut: "A_TELECHARGER", mediaStatut: "TELECHARGE", tentatives: 0 });
    expect((await admin.get(`/api/lieux/${lieuA}/medias/resume`).expect(200)).body).toMatchObject({ enAttente: 2, enErreur: 0 });
  });
});
