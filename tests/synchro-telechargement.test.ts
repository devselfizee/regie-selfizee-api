import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { cheminAbsolu } from "../src/lib/stockage.js";
import { dateLocaleBorne, lireJsonSeance, uuidCanonique } from "../src/synchro-pikcloud/json-seance.js";
import { recevoirMedia, type CorpsWebhook } from "../src/synchro-pikcloud/reception.js";
import { purgerMedias, telechargerEnAttente } from "../src/synchro-pikcloud/telechargement.js";
import { viderBase } from "./aide.js";

// Worker de téléchargement des médias PikCloud : un serveur HTTP local joue PikCloud, le stockage est
// un dossier temporaire. Pas de réseau.

const JSON_SEANCE = {
  borne_id: "S12",
  code_logiciel: "RA7K",
  platform: "regie",
  name_photo: "2026_11_04_21_42_17_00031.jpg",
  type: "multipose",
  date_photo: "2026-11-04 21:42:17",
  save_date: "2026-11-04 21:42:31",
  print_date: "2026-11-04 21:42:58",
  photo_uuid: "3F9C2A7E5B1D4C8A9E217D4B0C6A1F53",
  session_code: "K7MQ4Z",
  count_print: 2,
  price: 5,
  payment_status: "CBaccepted",
  testMode: false,
  champ_inconnu: { x: 1 },
};

interface Ressource {
  statut?: number;
  corps: Buffer;
  type: string;
  longueur?: number;
}
const ressources = new Map<string, Ressource>();
let serveur: Server;
let base: string;
let dossier: string;
let photoJpeg: Buffer;

beforeAll(async () => {
  dossier = await mkdtemp(join(tmpdir(), "regie-medias-"));
  process.env.MEDIAS_DIR = dossier;
  process.env.PIKCLOUD_HOTES_AUTORISES = "127.0.0.1";
  process.env.MEDIAS_TENTATIVES_MAX = "2";
  photoJpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#cc3333" } }).jpeg().toBuffer();
  serveur = createServer((req, res) => {
    const r = ressources.get(req.url ?? "");
    if (!r) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("introuvable");
    }
    res.writeHead(r.statut ?? 200, { "content-type": r.type, "content-length": r.longueur ?? r.corps.length });
    req.method === "HEAD" ? res.end() : res.end(r.corps);
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
});

afterAll(async () => {
  serveur.close();
  await rm(dossier, { recursive: true, force: true });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await viderBase();
  ressources.clear();
  ressources.set("/data.json", { corps: Buffer.from(JSON.stringify(JSON_SEANCE)), type: "application/json" });
  ressources.set("/photo.jpg", { corps: photoJpeg, type: "image/jpeg" });
  ressources.set("/bad.json", { corps: Buffer.from("ceci n'est pas du JSON"), type: "application/json" });
  delete process.env.MEDIAS_RETENTION_JOURS;
  delete process.env.MEDIAS_TAILLE_MAX_MO;
  delete process.env.PIKCLOUD_VERIFIER_LIENS;
});

const annoncer = (extra: Partial<CorpsWebhook> = {}, filename = "2026_11_04_21_42_17_00031") =>
  recevoirMedia(
    { platform: "regie", source: "upload", code_event: "RA7K", borne: "S12", type_media: "multipose", filename, data_url: `${base}/data.json`, media_url: `${base}/photo.jpg`, ...extra },
    "127.0.0.1"
  );
const media = () => prisma.media.findFirstOrThrow();
const passe = () => telechargerEnAttente({ ignorerDelai: true });
const existe = (relatif: string | null) => (relatif ? stat(cheminAbsolu(relatif)).then(() => true, () => false) : Promise.resolve(false));

describe("lecture du JSON de séance", () => {
  it("convertit les dates locales de la borne (Europe/Paris) et normalise le photo_uuid", () => {
    expect(dateLocaleBorne("2026-11-04 21:42:17")?.toISOString()).toBe("2026-11-04T20:42:17.000Z"); // heure d'hiver
    expect(dateLocaleBorne("2026-07-14 23:00:00")?.toISOString()).toBe("2026-07-14T21:00:00.000Z"); // heure d'été
    expect(dateLocaleBorne("n'importe quoi")).toBeNull();
    expect(dateLocaleBorne(undefined)).toBeNull();
    expect(uuidCanonique("3F9C2A7E5B1D4C8A9E217D4B0C6A1F53")).toBe("3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53");
    expect(uuidCanonique("3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53")).toBe("3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53");
    expect(uuidCanonique("pas-un-uuid")).toBeNull();
  });

  it("ne rend obligatoire que ce qu'on utilise et garde le reste", () => {
    const c = lireJsonSeance(JSON.stringify({ type: "photo", champs: [] }));
    expect(c).toMatchObject({ photoUuid: null, datePhoto: null, nbTirages: null, testMode: false, type: "photo" });
    expect(c.brut).toEqual({ type: "photo", champs: [] });
    expect(() => lireJsonSeance("{")).toThrow("JSON invalide");
    expect(() => lireJsonSeance(JSON.stringify({ count_print: "deux" }))).toThrow("count_print");
  });
});

describe("worker de téléchargement", () => {
  it("télécharge le JSON et le média, remplit la séance, copie le fichier avec son SHA-256 et une vignette", async () => {
    await annoncer();
    expect(await passe()).toEqual({ traites: 1, reussis: 2, echoues: 0 });

    const m = await media();
    expect(m).toMatchObject({
      dataStatut: "TELECHARGE",
      mediaStatut: "TELECHARGE",
      photoUuid: "3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53",
      nbTirages: 2,
      test: false,
      tailleOctets: photoJpeg.length,
      sha256: createHash("sha256").update(photoJpeg).digest("hex"),
      tentatives: 0,
      derniereErreur: null,
      nomFichier: "2026_11_04_21_42_17_00031.jpg", // name_photo du JSON
    });
    expect(m.datePhoto?.toISOString()).toBe("2026-11-04T20:42:17.000Z");
    expect(m.dateSave?.toISOString()).toBe("2026-11-04T20:42:31.000Z");
    expect(m.datePrint?.toISOString()).toBe("2026-11-04T20:42:58.000Z");
    expect(m.telechargeLe).toBeInstanceOf(Date);
    expect((m.brut as { price: number; champ_inconnu: unknown }).price).toBe(5);
    expect((m.brut as { champ_inconnu: unknown }).champ_inconnu).toEqual({ x: 1 });

    // Fichier nommé par l'uuid interne, jamais par le nom venu de PikCloud
    expect(m.mediaChemin).toBe(`${m.uuid.slice(0, 2)}/${m.uuid}.jpg`);
    expect(await readFile(cheminAbsolu(m.mediaChemin!))).toEqual(photoJpeg);
    expect(m.vignetteChemin).toBe(`${m.uuid.slice(0, 2)}/${m.uuid}.vignette.jpg`);
    const vignette = await sharp(cheminAbsolu(m.vignetteChemin!)).metadata();
    expect(vignette.width).toBe(480);
    expect(vignette.format).toBe("jpeg");

    // Plus rien à faire : la passe suivante est vide
    expect(await passe()).toEqual({ traites: 0, reussis: 0, echoues: 0 });
  });

  it("média seul (cas C) puis JSON : chaque fichier est traité quand il arrive", async () => {
    await annoncer({ source: "force", data_url: undefined });
    expect(await passe()).toEqual({ traites: 1, reussis: 1, echoues: 0 });
    expect(await media()).toMatchObject({ dataStatut: "ABSENT", mediaStatut: "TELECHARGE", photoUuid: null });

    await annoncer({ source: "force" });
    expect(await passe()).toEqual({ traites: 1, reussis: 1, echoues: 0 });
    expect(await media()).toMatchObject({ dataStatut: "TELECHARGE", mediaStatut: "TELECHARGE", photoUuid: "3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53" });
  });

  it("vidéo : copiée sans vignette, extension du lien", async () => {
    ressources.set("/clip.mp4", { corps: Buffer.alloc(4096, 7), type: "video/mp4" });
    await annoncer({ type_media: "slowmotion", media_url: `${base}/clip.mp4`, data_url: undefined, source: "force" });
    await passe();
    const m = await media();
    expect(m.mediaChemin).toMatch(/\.mp4$/);
    expect(m.vignetteChemin).toBeNull();
    expect(m.tailleOctets).toBe(4096);
  });

  it("testMode dans le JSON : la séance est marquée test", async () => {
    ressources.set("/data.json", { corps: Buffer.from(JSON.stringify({ ...JSON_SEANCE, testMode: true })), type: "application/json" });
    await annoncer({ is_fake: false });
    await passe();
    expect((await media()).test).toBe(true);
  });

  it("JSON illisible : réessaye, puis passe en erreur dans la file d'import ; le média est pris quand même", async () => {
    await annoncer({ data_url: `${base}/bad.json` });
    expect(await passe()).toEqual({ traites: 1, reussis: 1, echoues: 1 });
    let m = await media();
    expect(m).toMatchObject({ dataStatut: "A_TELECHARGER", mediaStatut: "TELECHARGE", tentatives: 1 });
    expect(m.derniereErreur).toContain("JSON de séance illisible");
    expect(await prisma.importErreur.count({ where: { code: { not: "EVENEMENT_INCONNU" } } })).toBe(0);

    expect(await passe()).toEqual({ traites: 1, reussis: 0, echoues: 1 });
    m = await media();
    expect(m).toMatchObject({ dataStatut: "ERREUR", tentatives: 2 });
    const erreurs = await prisma.importErreur.findMany({ where: { code: { not: "EVENEMENT_INCONNU" } } });
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0].code).toBe("JSON_ILLISIBLE");
    expect(erreurs[0].message).toContain("RA7K/2026_11_04_21_42_17_00031");
    expect(erreurs[0].importId).toBe(m.importId);
    expect(await passe()).toEqual({ traites: 0, reussis: 0, echoues: 0 });

    // Un renvoi PikCloud du JSON relance
    ressources.set("/bad.json", { corps: Buffer.from(JSON.stringify(JSON_SEANCE)), type: "application/json" });
    await annoncer({ data_url: `${base}/bad.json`, source: "force" });
    expect(await passe()).toEqual({ traites: 1, reussis: 1, echoues: 0 });
    expect(await media()).toMatchObject({ dataStatut: "TELECHARGE", tentatives: 0 });
  });

  it("lien qui ne répond pas : 4002 après les tentatives, sans fichier laissé derrière", async () => {
    await annoncer({ media_url: `${base}/absent.jpg` });
    await passe();
    await passe();
    const m = await media();
    expect(m).toMatchObject({ dataStatut: "TELECHARGE", mediaStatut: "ERREUR", mediaChemin: null, tentatives: 2 });
    expect(m.derniereErreur).toContain("HTTP 404");
    expect((await prisma.importErreur.findFirstOrThrow({ where: { code: { not: "EVENEMENT_INCONNU" } } })).code).toBe("TELECHARGEMENT_IMPOSSIBLE");
  });

  it("média plus gros que la limite : refusé, fichier temporaire nettoyé", async () => {
    process.env.MEDIAS_TAILLE_MAX_MO = "1";
    ressources.set("/gros.mp4", { corps: Buffer.alloc(1.5 * 1024 * 1024, 1), type: "video/mp4" });
    await annoncer({ media_url: `${base}/gros.mp4`, data_url: undefined, source: "force" });
    await passe();
    const m = await media();
    expect(m).toMatchObject({ mediaStatut: "A_TELECHARGER", tentatives: 1 });
    expect(m.derniereErreur).toContain("octets");
    const restes = await readdirRecursif(dossier);
    expect(restes.filter((f) => f.includes(m.uuid))).toEqual([]);
  });

  it("respecte un délai croissant entre deux tentatives", async () => {
    await annoncer({ media_url: `${base}/absent.jpg`, data_url: undefined, source: "force" });
    expect(await telechargerEnAttente()).toMatchObject({ traites: 1, echoues: 1 });
    // Échec il y a quelques millisecondes : pas de nouvel essai avant 2 minutes
    expect(await telechargerEnAttente()).toEqual({ traites: 0, reussis: 0, echoues: 0 });
    expect(await telechargerEnAttente({ ignorerDelai: true })).toMatchObject({ traites: 1 });
  });

  it("refuse un lien dont l'hôte n'est plus autorisé au moment du téléchargement", async () => {
    await annoncer({ data_url: undefined, source: "force" });
    process.env.PIKCLOUD_HOTES_AUTORISES = "api.pikcloud.io";
    try {
      await passe();
      expect((await media()).derniereErreur).toContain("non autorisé");
    } finally {
      process.env.PIKCLOUD_HOTES_AUTORISES = "127.0.0.1";
    }
  });
});

describe("vérification des liens à la réception", () => {
  it("un lien qui répond 404 est refusé tout de suite (4002), l'autre fichier est pris", async () => {
    process.env.PIKCLOUD_VERIFIER_LIENS = "1";
    const r = await annoncer({ media_url: `${base}/absent.jpg` });
    expect(r.data).toMatchObject({ success: true });
    expect(r.photo).toMatchObject({ success: false, status: { code: 4002 } });
    expect(r.photo?.status.message).toContain("HTTP 404");
    expect(await media()).toMatchObject({ dataStatut: "A_TELECHARGER", mediaUrl: null, mediaStatut: "ABSENT" });
    const lot = await prisma.importLot.findFirstOrThrow({ include: { erreurs: true } });
    expect(lot.erreurs.map((e) => e.code)).toContain("TELECHARGEMENT_IMPOSSIBLE");
  });

  it("un lien qui répond est accepté", async () => {
    process.env.PIKCLOUD_VERIFIER_LIENS = "1";
    const r = await annoncer();
    expect(r).toMatchObject({ data: { success: true }, photo: { success: true } });
  });
});

describe("rétention", () => {
  it("purge les fichiers des médias plus anciens que MEDIAS_RETENTION_JOURS, garde la ligne", async () => {
    await annoncer();
    await annoncer({}, "2026_11_04_21_50_00_00032");
    await passe();
    const [ancien, recent] = await prisma.media.findMany({ orderBy: { id: "asc" } });
    await prisma.media.update({ where: { id: ancien.id }, data: { dateSave: new Date("2026-06-01T20:00:00Z") } });

    expect(await purgerMedias(new Date("2026-11-05T12:00:00Z"))).toBe(0); // variable vide : pas de purge
    process.env.MEDIAS_RETENTION_JOURS = "90";
    expect(await purgerMedias(new Date("2026-11-05T12:00:00Z"))).toBe(1);

    const purge = await prisma.media.findUniqueOrThrow({ where: { id: ancien.id } });
    expect(purge).toMatchObject({ mediaStatut: "PURGE", mediaChemin: null, vignetteChemin: null, dataStatut: "TELECHARGE", photoUuid: "3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53" });
    expect(await existe(ancien.mediaChemin)).toBe(false);
    expect(await existe(ancien.vignetteChemin)).toBe(false);
    const garde = await prisma.media.findUniqueOrThrow({ where: { id: recent.id } });
    expect(garde.mediaStatut).toBe("TELECHARGE");
    expect(await existe(garde.mediaChemin)).toBe(true);
    expect(await purgerMedias(new Date("2026-11-05T12:00:00Z"))).toBe(0);
  });
});

async function readdirRecursif(racine: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entrees = await readdir(racine, { withFileTypes: true, recursive: true });
  return entrees.filter((e) => e.isFile()).map((e) => e.name);
}
