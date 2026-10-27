import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { genererCle } from "../src/lib/cleBorne.js";
import { initialiserReferentiel } from "../src/referentiel/initial.js";
import { viderBase } from "./aide.js";

// Parcours invité : ingestion, doublons, conflits, rattachement au lieu, entonnoir (avenant du 26/10/2026)
const app = creerApp();
const api = request(app);
afterAll(() => prisma.$disconnect());

let cle: string;
let lieuId: number;

beforeEach(async () => {
  await viderBase();
  await initialiserReferentiel();
  const bar = await prisma.refValeur.findFirstOrThrow({ where: { categorie: "TYPE_LIEU", code: "BAR" } });
  const gamme = await prisma.gamme.findUniqueOrThrow({ where: { code: "SPHERIK" } });
  const k = genererCle();
  cle = k.cle;
  const borne = await prisma.borne.create({ data: { identifiant: "S513", gammeId: gamme.id, apiKeyHash: k.hash, apiKeyPrefix: k.prefixe } });
  lieuId = (await prisma.lieu.create({ data: { raisonSociale: "R", enseigne: "La Ruche", typeLieuId: bar.id } })).id;
  await prisma.affectationBorne.create({ data: { borneId: borne.id, lieuId, debut: new Date("2026-10-01T00:00:00Z") } });
});

const seance = (id: string, etapes: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  parcours_id: `S513-20261022-${id}`, evenement: "FJT5", kit: "nightlife",
  debut: "2026-10-22T23:10:00+02:00", fin: "2026-10-22T23:11:00+02:00", duree_s: 60,
  issue: "validee", etapes, photos: 1, tirages: 0, ...extra,
});
const h = (mm: string) => `2026-10-22T23:${mm}:00+02:00`;
const envoyer = (parcours: unknown[]) =>
  api.post("/ingest/v1/parcours").set("Authorization", `Bearer ${cle}`).send({
    schema_version: "1.0", borne_id: "S513", envoye_le: "2026-10-22T23:12:00+02:00", logiciel_version: "1", parcours,
  });

describe("parcours invité", () => {
  it("enregistre, rattache au lieu, reconnaît les doublons et refuse un contenu différent", async () => {
    const a = seance("AAAAAA", { cadre: h("10"), photo: h("10"), offre: h("10"), paiement: h("11") }, { paiement: { demandes: 1, statut: "accepte", montant_ttc_centimes: 350 }, tirages: 1 });
    const r1 = (await envoyer([a]).expect(200)).body;
    expect(r1).toMatchObject({ recus: 1, crees: 1, doublons: 0, rejetees: 0, non_affectees: 0 });
    expect((await prisma.parcours.findFirstOrThrow()).lieuId).toBe(lieuId);

    const r2 = (await envoyer([a, { ...a, duree_s: 61 }]).expect(200)).body;
    expect(r2.doublons).toBe(1);
    expect(r2.erreurs.map((e: { code: string }) => e.code)).toEqual(["DOUBLON_DANS_LE_LOT"]);

    const r3 = (await envoyer([{ ...a, duree_s: 61 }]).expect(200)).body;
    expect(r3.erreurs[0]).toMatchObject({ parcours_id: a.parcours_id, code: "CONFLIT_DOUBLON" });
  });

  it("entonnoir : une étape non atteinte ne compte pas", async () => {
    await envoyer([
      seance("AAAAAA", { cadre: h("10"), photo: h("10"), offre: h("10"), paiement: h("11") }, { paiement: { demandes: 1, statut: "accepte", montant_ttc_centimes: 350 } }),
      seance("BBBBBB", { cadre: h("10"), photo: h("10"), offre: h("10") }),
      seance("T231000", { cadre: h("10") }, { issue: "delai", photos: 0 }),
    ]).expect(200);
    const e = (await api.get(`/api/stats/lieux/${lieuId}/parcours?du=2026-10-22&au=2026-10-22`).expect(200)).body;
    expect(e.commencees).toBe(3);
    expect(e.etapes).toMatchObject({ cadre: 3, photo: 2, offre: 2, paiement: 1, impression: 0 });
    expect(e.payees).toBe(1);
  });
});
