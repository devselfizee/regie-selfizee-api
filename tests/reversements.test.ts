import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { genererCle } from "../src/lib/cleBorne.js";
import { calculerReversements } from "../src/commissions/service.js";
import { viderBase } from "./aide.js";

const app = creerApp();
const api = request(app);
const FIN_SEPTEMBRE = new Date("2026-09-30T00:00:00Z");

let lieuId: number;
let cle: string;
let n = 0;

/** Envoie des ventes acceptées (montant en euros) à des dates données, par l'API d'ingestion. */
async function vendre(ventes: [date: string, euros: number][]) {
  await api
    .post("/ingest/v1/transactions")
    .set("Authorization", `Bearer ${cle}`)
    .send({
      schema_version: "1.0",
      borne_id: "MT-0042",
      envoye_le: "2026-10-05T10:00:00+02:00",
      logiciel_version: "3.4.1",
      transactions: ventes.map(([date, euros]) => ({
        transaction_id: `T-${++n}`,
        horodatage: `${date}T15:00:00+02:00`,
        montant_ttc_centimes: euros * 100,
        devise: "EUR",
        statut: "accepte",
        module: { type: "INGENICO_SELF_2000" },
        moyen_paiement: "sans_contact",
        produit: { code: "BANDE_4", nb_tirages: 2 },
      })),
    })
    .expect(200);
}

const contratSeuil = {
  modele: "POURCENTAGE_APRES_SEUIL",
  tauxBp: 2500,
  seuilCents: 50000,
  seuilMode: "AU_DELA",
  periodicite: "MOIS",
  dateEffet: "2026-08-01",
};

const reversements = () => prisma.reversement.findMany({ orderBy: { periodeDebut: "asc" } });
const montants = async () => (await reversements()).map((r) => r.montantAReverserCents / 100);

afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await viderBase();
  await prisma.contratCommission.deleteMany();
  const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "CAMPING", libelle: "Camping" } });
  const gamme = await prisma.gamme.create({ data: { code: "MT", libelle: "Ma Trombine" } });
  await prisma.typeModulePaiement.create({ data: { code: "INGENICO_SELF_2000", libelle: "Ingenico" } });
  lieuId = (await prisma.lieu.create({ data: { raisonSociale: "SARL Camping", enseigne: "Camping", typeLieuId: type.id, siret: "12345678900012" } })).id;
  const k = genererCle();
  const borne = await prisma.borne.create({ data: { identifiant: "MT-0042", gammeId: gamme.id, numeroSerie: "S", apiKeyHash: k.hash, apiKeyPrefix: k.prefixe } });
  await prisma.affectationBorne.create({ data: { borneId: borne.id, lieuId, debut: new Date("2026-01-01T00:00:00Z") } });
  cle = k.cle;
  // Août : 800 €, septembre : 300 €
  await vendre([["2026-08-10", 500], ["2026-08-20", 300], ["2026-09-05", 300]]);
});

describe("calcul des reversements", () => {
  it("calcule chaque mois terminé selon le contrat", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    const r = await reversements();
    expect(r.map((x) => x.periodeDebut.toISOString().slice(0, 10))).toEqual(["2026-08-01", "2026-09-01"]);
    expect(await montants()).toEqual([75, 0]); // 25 % × (800 − 500) ; 300 € < seuil
    expect(r[0].statut).toBe("CALCULE");
    expect((r[0].detailCalcul as { periode: string }).periode).toBe("août 2026");
  });

  it("est idempotent : recalculer ne crée pas de doublon", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    expect(await prisma.reversement.count()).toBe(2);
  });

  it("une correction manuelle est tracée et survit au recalcul", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    const [aout] = await reversements();
    await api.post(`/api/reversements/${aout.id}/ajustements`).send({ montantCents: 1000, motif: "Geste commercial" }).expect(201);
    await api.post(`/api/reversements/${aout.id}/ajustements`).send({ montantCents: 500 }).expect(400); // motif obligatoire
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    const r = await prisma.reversement.findUniqueOrThrow({ where: { id: aout.id }, include: { ajustements: true } });
    expect(r.montantAReverserCents).toBe(8500);
    expect(r.ajustements[0]).toMatchObject({ montantCents: 1000, motif: "Geste commercial" });
  });

  it("une période validée ne bouge plus, même si des ventes arrivent en retard", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    const [aout] = await reversements();
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "VALIDE" }).expect(200);

    await vendre([["2026-08-25", 400], ["2026-09-25", 400]]); // rattrapage d'une borne
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    expect(await montants()).toEqual([75, 50]); // août figé ; septembre : 25 % × (700 − 500)
  });
});

describe("avenants", () => {
  it("refuse une date d'effet en milieu de période ou sur une période validée", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    const [aout] = await reversements();
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "VALIDE" }).expect(200);

    const milieu = await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send({ ...contratSeuil, dateEffet: "2026-09-15" });
    expect(milieu.status).toBe(400);
    expect(milieu.body.champs[0].chemin).toBe("dateEffet");

    const aoutValide = await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send({ ...contratSeuil, dateEffet: "2026-08-01" });
    expect(aoutValide.status).toBe(400);
  });

  it("un avenant ne recalcule pas le passé validé, seulement les périodes ouvertes", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    const [aout] = await reversements();
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "VALIDE" }).expect(200);

    // Avenant au 1er septembre : 10 % dès le premier euro
    await api
      .post(`/api/commissions/lieux/${lieuId}/contrats`)
      .send({ modele: "POURCENTAGE", tauxBp: 1000, periodicite: "MOIS", dateEffet: "2026-09-01", motifAvenant: "Renégociation" })
      .expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });

    expect(await montants()).toEqual([75, 30]);
    const contrats = await prisma.contratCommission.findMany({ orderBy: { version: "asc" } });
    expect(contrats.map((c) => [c.version, c.dateFin?.toISOString().slice(0, 10) ?? null])).toEqual([
      [1, "2026-09-01"],
      [2, null],
    ]);
    const sept = (await reversements())[1];
    expect(sept.contratId).toBe(contrats[1].id);
  });

  it("supprimer la dernière version rouvre la précédente", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    const v2 = (await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send({ modele: "AUCUNE", dateEffet: "2026-09-01" }).expect(201)).body;
    await api.delete(`/api/commissions/contrats/${v2.id}`).expect(204);
    const v1 = await prisma.contratCommission.findFirstOrThrow();
    expect(v1.dateFin).toBeNull();
  });
});

describe("statuts, droits et export", () => {
  it("suit le cycle validé → autofacturé → payé, et refuse les sauts", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    const [aout] = await reversements();
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "PAYE" }).expect(400);
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "VALIDE" }).expect(200);
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "AUTOFACTURE", numeroFacture: "AF-2026-001" }).expect(200);
    const paye = (await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "PAYE" }).expect(200)).body;
    expect(paye.numeroFacture).toBe("AF-2026-001");
    expect(paye.payeLe).not.toBeNull();
    // Correction impossible après validation
    await api.post(`/api/reversements/${aout.id}/ajustements`).send({ montantCents: 100, motif: "Trop tard" }).expect(400);
  });

  it("le partenaire voit ses reversements, pas le commercial ; export compta des validés", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    await prisma.user.create({ data: { email: "p@test.fr", nom: "P", prenom: "", role: "PARTENAIRE", lieuId } });
    await prisma.user.create({ data: { email: "c@test.fr", nom: "C", prenom: "", role: "COMMERCIAL" } });

    const vus = (await api.get("/api/reversements").set("X-Dev-Utilisateur", "p@test.fr").expect(200)).body;
    expect(vus).toHaveLength(2);
    const releve = (await api.get(`/api/reversements/${vus[0].id}`).set("X-Dev-Utilisateur", "p@test.fr").expect(200)).body;
    expect(releve.lieu.enseigne).toBe("Camping");
    await api.get("/api/reversements").set("X-Dev-Utilisateur", "c@test.fr").expect(403);
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).set("X-Dev-Utilisateur", "p@test.fr").send(contratSeuil).expect(403);

    const [aout] = await reversements();
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "VALIDE" }).expect(200);
    const csv = (await api.get("/api/reversements/export.csv").expect(200)).text;
    expect(csv).toContain("Camping;SARL Camping;12345678900012;;01/08/2026;31/08/2026;800,00;75,00;0,00;75,00;VALIDE");
    expect(csv.trim().split("\r\n")).toHaveLength(2); // en-tête + août (septembre n'est pas validé)
    const xlsx = await api.get("/api/reversements/export.xlsx").expect(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    expect(xlsx.headers["content-disposition"]).toMatch(/reversements_.*\.xlsx/);
  });

  it("simule un contrat pour l'aperçu du formulaire", async () => {
    const res = (await api.post("/api/commissions/simuler").send({ ...contratSeuil, exemplesCents: [40000, 80000] }).expect(200)).body;
    expect(res.exemples.map((e: { commissionCents: number }) => e.commissionCents)).toEqual([0, 7500]);
    expect(res.description).toContain("au-delà de 500,00");
  });

  it("donne la commission en cours et la position par rapport au seuil", async () => {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    const data = (await api.get(`/api/commissions/lieux/${lieuId}`).expect(200)).body;
    expect(data.contrats[0].description).toContain("25 %");
    expect(data.enCours.seuil.seuilCents).toBe(50000);
  });
});

describe("relevé PDF et envoi par e-mail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MAILJET_API_KEY;
    delete process.env.MAILJET_API_SECRET;
  });

  async function moisValide() {
    await api.post(`/api/commissions/lieux/${lieuId}/contrats`).send(contratSeuil).expect(201);
    await calculerReversements({ jusquA: FIN_SEPTEMBRE });
    const [aout] = await reversements();
    return aout;
  }

  it("génère le relevé en PDF, accessible au partenaire du lieu", async () => {
    const aout = await moisValide();
    const res = await api.get(`/api/reversements/${aout.id}/releve.pdf`).buffer(true).parse((r, cb) => {
      const morceaux: Buffer[] = [];
      r.on("data", (m: Buffer) => morceaux.push(m));
      r.on("end", () => cb(null, Buffer.concat(morceaux)));
    }).expect(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("releve_camping_2026-08.pdf");
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");

    await prisma.user.create({ data: { email: "p@test.fr", nom: "P", prenom: "", role: "PARTENAIRE", lieuId } });
    await api.get(`/api/reversements/${aout.id}/releve.pdf`).set("X-Dev-Utilisateur", "p@test.fr").expect(200);
  });

  it("refuse d'envoyer un relevé non validé, ou sans Mailjet configuré", async () => {
    const aout = await moisValide();
    const envoi = () => api.post(`/api/reversements/${aout.id}/envoyer`).send({ destinataires: ["compta@camping.fr"] });
    expect((await envoi()).body.error).toBe("STATUT");
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "VALIDE" }).expect(200);
    const res = await envoi();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("ENVOI_NON_CONFIGURE");
    expect((await prisma.reversement.findUniqueOrThrow({ where: { id: aout.id } })).envoyeLe).toBeNull();
  });

  it("envoie le PDF en pièce jointe via Mailjet et trace l'envoi", async () => {
    process.env.MAILJET_API_KEY = "cle";
    process.env.MAILJET_API_SECRET = "secret";
    const appels: { url: string; corps: { Messages: { To: { Email: string }[]; Subject: string; Attachments: { Filename: string; Base64Content: string }[] }[] } }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      appels.push({ url, corps: JSON.parse(init.body) });
      return new Response(JSON.stringify({ Messages: [{ Status: "success" }] }), { status: 200 });
    }));

    const aout = await moisValide();
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "VALIDE" }).expect(200);
    await api.post(`/api/reversements/${aout.id}/envoyer`).send({ destinataires: ["Compta@Camping.fr"], message: "Bonne réception" }).expect(200);

    const m = appels[0].corps.Messages[0];
    expect(appels[0].url).toBe("https://api.mailjet.com/v3.1/send");
    expect(m.To).toEqual([{ Email: "compta@camping.fr" }]);
    expect(m.Subject).toContain("Camping");
    expect(m.Attachments[0].Filename).toBe("releve_camping_2026-08.pdf");
    expect(Buffer.from(m.Attachments[0].Base64Content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect((await prisma.reversement.findUniqueOrThrow({ where: { id: aout.id } })).envoyeLe).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "ENVOI_RELEVE" } })).toBe(1);
  });

  it("envoi groupé aux contacts de la fiche ; signale les lieux sans e-mail", async () => {
    process.env.MAILJET_API_KEY = "cle";
    process.env.MAILJET_API_SECRET = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Messages: [{ Status: "success" }] }), { status: 200 })));
    const aout = await moisValide();
    await api.patch(`/api/reversements/${aout.id}/statut`).send({ statut: "VALIDE" }).expect(200);

    const sans = (await api.post("/api/reversements/envoyer-valides").expect(200)).body;
    expect(sans).toMatchObject({ envoyes: 0, sansDestinataire: ["Camping (août 2026)"] });

    await prisma.lieuContact.createMany({
      data: [
        { lieuId, role: "GERANT", nom: "Gérant", email: "gerant@camping.fr" },
        { lieuId, role: "COMPTABILITE", nom: "Compta", email: "compta@camping.fr" },
      ],
    });
    const releve = (await api.get(`/api/reversements/${aout.id}`).expect(200)).body;
    expect(releve.destinatairesParDefaut).toEqual(["compta@camping.fr"]);
    expect((await api.post("/api/reversements/envoyer-valides").expect(200)).body.envoyes).toBe(1);
    expect((await api.post("/api/reversements/envoyer-valides").expect(200)).body.envoyes).toBe(0); // déjà envoyé
  });
});
