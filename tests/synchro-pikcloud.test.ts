import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { initialiserReferentiel } from "../src/referentiel/initial.js";
import { viderBase } from "./aide.js";

// Webhook de synchro des médias PikCloud (contrat du 04/11/2026) : secret, cas A / B / C, doublons,
// événement inconnu, hôtes autorisés. Les téléchargements sont testés avec le worker, pas ici.
const SECRET = "secret-de-test";
process.env.PIKCLOUD_SYNCHRO_SECRET = SECRET;

const app = creerApp();
const api = request(app);
afterAll(() => prisma.$disconnect());

let lieuId: number;
let evenementId: number;
let borneId: number;

beforeEach(async () => {
  await viderBase();
  await initialiserReferentiel();
  process.env.PIKCLOUD_SYNCHRO_SECRET = SECRET;
  delete process.env.PIKCLOUD_HOTES_AUTORISES;
  const bar = await prisma.refValeur.findFirstOrThrow({ where: { categorie: "TYPE_LIEU", code: "BAR" } });
  const gamme = await prisma.gamme.findUniqueOrThrow({ where: { code: "SPHERIK" } });
  borneId = (await prisma.borne.create({ data: { identifiant: "S12", gammeId: gamme.id } })).id;
  lieuId = (await prisma.lieu.create({ data: { raisonSociale: "R", enseigne: "La Ruche", typeLieuId: bar.id } })).id;
  evenementId = (await prisma.configEvenement.create({ data: { lieuId, code: "RA7K", motDePasseTableau: "1234", reglages: {} } })).id;
});

const BASE = "https://apidev.pikcloud.io/uploads/S12/files/RA7K";
const FICHIER = "2026_11_04_21_42_17_00031";
const dataUrl = `${BASE}/Data/${FICHIER}.json`;
const mediaUrl = `${BASE}/multipose/${FICHIER}.jpg`;

const appel = (extra: Record<string, unknown> = {}, source = "upload") => ({
  platform: "regie",
  source,
  code_event: "RA7K",
  borne: "S12",
  type_media: "multipose",
  filename: FICHIER,
  ...extra,
});
const envoyer = (corps: object, token: string | null = SECRET) => {
  const r = api.post("/webhooks/v1/pikcloud/medias");
  return (token === null ? r : r.set("X-Synchro-Token", token)).send(corps);
};
const OK = { success: true, status: { code: 200 } };

describe("webhook PikCloud : authentification", () => {
  it("refuse sans token ou avec un mauvais token, et journalise le rejet", async () => {
    await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl }), null).expect(401);
    await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl }), "faux").expect(401);
    expect(await prisma.media.count()).toBe(0);
    const rejets = await prisma.importLot.findMany({ where: { type: "MEDIAS", statut: "REJETE" }, include: { erreurs: true } });
    expect(rejets).toHaveLength(2);
    expect(rejets[0].erreurs[0].code).toBe("TOKEN_INVALIDE");
    expect(rejets[0].borneIdentifiant).toBe("S12");
  });

  it("répond 503 tant que le secret n'est pas configuré", async () => {
    delete process.env.PIKCLOUD_SYNCHRO_SECRET;
    await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl }), "x").expect(503);
  });

  it("refuse un corps hors contrat (400) : nom de fichier avec chemin, aucune URL", async () => {
    const r = await envoyer(appel({ data_url: dataUrl, filename: "../x" })).expect(400);
    expect(r.body.error).toBe("SCHEMA_INVALIDE");
    expect(r.body.message).toContain("filename");
    await envoyer(appel()).expect(400);
    expect(await prisma.importErreur.count({ where: { code: "SCHEMA_INVALIDE" } })).toBe(2);
  });
});

describe("webhook PikCloud : réception", () => {
  it("cas A : premier envoi, une ligne rattachée à l'événement, au lieu et à la borne, les deux fichiers à télécharger", async () => {
    const r = await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl, is_fake: false })).expect(200);
    expect(r.body).toMatchObject({ data: OK, photo: OK });

    const m = await prisma.media.findUniqueOrThrow({ where: { codeEvent_filename: { codeEvent: "RA7K", filename: FICHIER } } });
    expect(m).toMatchObject({
      configEvenementId: evenementId,
      lieuId,
      borneId,
      borneIdentifiant: "S12",
      typeMedia: "multipose",
      test: false,
      dataUrl,
      dataStatut: "A_TELECHARGER",
      mediaUrl,
      mediaStatut: "A_TELECHARGER",
      photoUuid: null,
      nomFichier: `${FICHIER}.jpg`, // d'après le lien, en attendant le name_photo du JSON
    });
    expect(m.uuid).toMatch(/^[0-9a-f-]{36}$/);

    const lot = await prisma.importLot.findFirstOrThrow({ where: { type: "MEDIAS" }, include: { erreurs: true } });
    expect(lot).toMatchObject({ statut: "OK", borneId, nbRecues: 2, nbCreees: 1, nbDoublons: 0, nbRejetees: 0 });
    expect(lot.erreurs).toHaveLength(0);
  });

  it("séance de test (is_fake) : stockée et marquée test", async () => {
    await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl, is_fake: true })).expect(200);
    expect((await prisma.media.findFirstOrThrow()).test).toBe(true);
  });

  it("renvoi (cas B) d'un fichier déjà téléchargé : succès « déjà reçu », aucun doublon, rien d'écrasé", async () => {
    await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl })).expect(200);
    const m = await prisma.media.findFirstOrThrow();
    await prisma.media.update({
      where: { id: m.id },
      data: { dataStatut: "TELECHARGE", mediaStatut: "TELECHARGE", mediaChemin: "ab/x.jpg", photoUuid: "3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53" },
    });

    const r = await envoyer(appel({ data_url: `${dataUrl}?signature=abc`, media_url: mediaUrl }, "force")).expect(200);
    expect(r.body.data).toMatchObject({ success: true, status: { code: 200, message: "Fichier déjà reçu" } });
    expect(r.body.photo).toMatchObject({ success: true, status: { code: 200, message: "Fichier déjà reçu" } });

    expect(await prisma.media.count()).toBe(1);
    const apres = await prisma.media.findFirstOrThrow();
    expect(apres).toMatchObject({ dataUrl, mediaChemin: "ab/x.jpg", mediaStatut: "TELECHARGE", photoUuid: "3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53" });
    const lots = await prisma.importLot.findMany({ where: { type: "MEDIAS" }, orderBy: { id: "asc" } });
    expect(lots).toHaveLength(2);
    expect(lots[1]).toMatchObject({ nbRecues: 2, nbCreees: 0, nbDoublons: 2 });
  });

  it("renvoi d'un fichier encore en attente : succès, lien le plus récent conservé", async () => {
    await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl })).expect(200);
    const r = await envoyer(appel({ data_url: dataUrl, media_url: `${mediaUrl}?signature=nouvelle` }, "force")).expect(200);
    expect(r.body.photo.status.message).toContain("en attente");
    const m = await prisma.media.findFirstOrThrow();
    expect(m).toMatchObject({ mediaUrl: `${mediaUrl}?signature=nouvelle`, mediaStatut: "A_TELECHARGER" });
  });

  it("cas C puis B : le média arrive seul, le JSON le rejoint sur la même ligne", async () => {
    const c = await envoyer(appel({ media_url: mediaUrl }, "force")).expect(200);
    expect(c.body).toMatchObject({ photo: OK });
    expect(c.body.data).toBeUndefined();
    let m = await prisma.media.findFirstOrThrow();
    expect(m).toMatchObject({ dataUrl: null, dataStatut: "ABSENT", mediaUrl, mediaStatut: "A_TELECHARGER" });

    const b = await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl }, "force")).expect(200);
    expect(b.body.data).toMatchObject(OK);
    expect(b.body.photo.status.message).toContain("en attente");
    expect(await prisma.media.count()).toBe(1);
    m = await prisma.media.findFirstOrThrow();
    expect(m).toMatchObject({ dataUrl, dataStatut: "A_TELECHARGER", mediaStatut: "A_TELECHARGER" });
  });

  it("un renvoi relance un fichier en erreur", async () => {
    await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl })).expect(200);
    const m = await prisma.media.findFirstOrThrow();
    await prisma.media.update({ where: { id: m.id }, data: { mediaStatut: "ERREUR", tentatives: 5, derniereErreur: "HTTP 404" } });
    await envoyer(appel({ media_url: mediaUrl }, "force")).expect(200);
    expect(await prisma.media.findFirstOrThrow()).toMatchObject({ mediaStatut: "A_TELECHARGER", tentatives: 0, derniereErreur: null });
  });

  it("événement inconnu : média stocké sans lieu, succès pour PikCloud, erreur tracée ; rattaché quand l'événement apparaît", async () => {
    const r = await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl, code_event: "RZZZ" })).expect(200);
    expect(r.body).toMatchObject({ data: OK, photo: OK });
    const m = await prisma.media.findFirstOrThrow();
    expect(m).toMatchObject({ codeEvent: "RZZZ", configEvenementId: null, lieuId: null });
    const lot = await prisma.importLot.findFirstOrThrow({ where: { type: "MEDIAS" }, include: { erreurs: true } });
    expect(lot.statut).toBe("PARTIEL");
    expect(lot.erreurs.map((e) => e.code)).toEqual(["EVENEMENT_INCONNU"]);

    // L'événement est créé plus tard (ou le code corrigé) : un renvoi rattache la ligne
    await prisma.configEvenement.create({ data: { lieuId, habituel: false, nom: "Soirée", code: "RZZZ", motDePasseTableau: "1", reglages: {} } });
    await envoyer(appel({ media_url: mediaUrl, code_event: "RZZZ" }, "force")).expect(200);
    expect((await prisma.media.findFirstOrThrow()).lieuId).toBe(lieuId);
  });

  it("borne inconnue : stockée avec son identifiant, sans borne_id", async () => {
    await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl, borne: "S99" })).expect(200);
    expect(await prisma.media.findFirstOrThrow()).toMatchObject({ borneId: null, borneIdentifiant: "S99" });
  });

  it("lien hors des hôtes PikCloud : ce fichier est refusé (4004), l'autre est pris", async () => {
    const r = await envoyer(appel({ data_url: dataUrl, media_url: "https://evil.example.com/x.jpg" })).expect(200);
    expect(r.body.data).toMatchObject(OK);
    expect(r.body.photo).toMatchObject({ success: false, status: { code: 4004 } });
    expect(r.body.photo.status.message).toContain("evil.example.com");
    const m = await prisma.media.findFirstOrThrow();
    expect(m).toMatchObject({ dataStatut: "A_TELECHARGER", mediaUrl: null, mediaStatut: "ABSENT" });
    const lot = await prisma.importLot.findFirstOrThrow({ where: { type: "MEDIAS" }, include: { erreurs: true } });
    expect(lot).toMatchObject({ statut: "PARTIEL", nbRejetees: 1 });
    expect(lot.erreurs.map((e) => e.code)).toEqual(["HOTE_INTERDIT"]);

    // Liste réglable : un hôte local pour les essais
    process.env.PIKCLOUD_HOTES_AUTORISES = "127.0.0.1, localhost";
    const r2 = await envoyer(appel({ media_url: "http://localhost:9999/x.jpg" }, "force")).expect(200);
    expect(r2.body.photo).toMatchObject(OK);
  });

  it("ignore les champs inconnus de l'appel", async () => {
    await envoyer(appel({ data_url: dataUrl, media_url: mediaUrl, nouveau_champ: 1, type_media: "hologramme" })).expect(200);
    expect((await prisma.media.findFirstOrThrow()).typeMedia).toBe("hologramme");
  });
});
