import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { genererCle } from "../src/lib/cleBorne.js";
import { evaluerAlertes } from "../src/alertes/evaluation.js";
import { notifierAlertes } from "../src/alertes/notifications.js";
import { ouvertA } from "../src/alertes/ouverture.js";
import { viderBase } from "./aide.js";

const app = creerApp();
const api = request(app);

// Mercredi 30 septembre 2026, 16 h à Paris (UTC+2)
const MAINTENANT = new Date("2026-09-30T14:00:00Z");
const ilYa = (heures: number) => new Date(MAINTENANT.getTime() - heures * 3_600_000);
const heure = (h: string) => new Date(`1970-01-01T${h}:00Z`);

let lieuId: number;
let borneId: number;
let cle: string;
let typeModuleId: number;
let n = 0;

async function vendre(ventes: [isoParis: string, euros: number, statut?: "accepte" | "refuse"][]) {
  await api
    .post("/ingest/v1/transactions")
    .set("Authorization", `Bearer ${cle}`)
    .send({
      schema_version: "1.0", borne_id: "MT-0042", envoye_le: "2026-09-30T16:00:00+02:00", logiciel_version: "3.4.1",
      transactions: ventes.map(([h, euros, statut = "accepte"]) => ({
        transaction_id: `T-${++n}`, horodatage: `${h}+02:00`, montant_ttc_centimes: euros * 100, devise: "EUR", statut,
        module: { type: "INGENICO_SELF_2000" }, moyen_paiement: "cb", produit: { code: "B4", nb_tirages: statut === "accepte" ? 2 : 0 },
      })),
    })
    .expect(200);
}

/** CA journalier directement dans les agrégats (historique long). */
async function caJournalier(du: string, jours: number, euros: number) {
  for (let i = 0; i < jours; i++) {
    const jour = new Date(new Date(`${du}T00:00:00Z`).getTime() + i * 86_400_000);
    await prisma.aggJour.create({
      data: { jour, lieuId, borneId, typeModuleId, moyenPaiement: "CB", nbAcceptees: 10, caTtcCents: euros * 100, caHtCents: euros * 80 },
    });
  }
}

const enLigne = () => prisma.borne.update({ where: { id: borneId }, data: { dernierHeartbeat: ilYa(0.1) } });
const alertes = (type?: string) => prisma.alerte.findMany({ where: type ? { type: type as never } : {}, orderBy: { id: "asc" } });

afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await viderBase();
  await prisma.notificationAlerte.deleteMany();
  await prisma.regleAlerte.deleteMany();
  const type = await prisma.refValeur.create({ data: { categorie: "TYPE_LIEU", code: "BAR", libelle: "Bar" } });
  const gamme = await prisma.gamme.create({ data: { code: "MT", libelle: "Ma Trombine" } });
  typeModuleId = (await prisma.typeModulePaiement.create({ data: { code: "INGENICO_SELF_2000", libelle: "Ingenico" } })).id;
  lieuId = (
    await prisma.lieu.create({
      data: {
        raisonSociale: "SAS Bar", enseigne: "Bar du Port", typeLieuId: type.id,
        horaires: { create: [1, 2, 3, 4, 5, 6, 7].map((j) => ({ jourSemaine: j, ouverture: heure("10:00"), fermeture: heure("22:00") })) },
      },
    })
  ).id;
  const k = genererCle();
  borneId = (
    await prisma.borne.create({
      data: { identifiant: "MT-0042", gammeId: gamme.id, numeroSerie: "S", statut: "INSTALLEE", apiKeyHash: k.hash, apiKeyPrefix: k.prefixe },
    })
  ).id;
  cle = k.cle;
  await prisma.affectationBorne.create({ data: { borneId, lieuId, debut: new Date("2026-07-01T00:00:00Z") } });
});

describe("heures d'ouverture", () => {
  it("gère les créneaux qui passent minuit et les fermetures", () => {
    const boite = {
      saisonnalite: "ANNUEL" as const,
      horaires: [{ jourSemaine: 5, ouverture: heure("23:00"), fermeture: heure("05:00") }], // vendredi soir
      saisons: [],
      fermetures: [{ debut: new Date("2026-10-16T00:00:00Z"), fin: new Date("2026-10-16T00:00:00Z") }],
    };
    expect(ouvertA(boite, new Date("2026-10-09T21:30:00Z"))).toBe(true); // vendredi 23 h 30
    expect(ouvertA(boite, new Date("2026-10-10T01:00:00Z"))).toBe(true); // samedi 3 h (nuit du vendredi)
    expect(ouvertA(boite, new Date("2026-10-10T04:00:00Z"))).toBe(false); // samedi 6 h
    expect(ouvertA(boite, new Date("2026-10-16T21:30:00Z"))).toBe(false); // vendredi fermé exceptionnellement
  });
});

describe("borne muette", () => {
  it("alerte pendant les heures d'ouverture, sans doublon, puis se résout quand la borne revient", async () => {
    await prisma.borne.update({ where: { id: borneId }, data: { dernierHeartbeat: ilYa(3) } });
    const r = await evaluerAlertes(MAINTENANT);
    expect(r.creees.map((a) => [a.type, a.niveau])).toContainEqual(["BORNE_MUETTE", "CRITIQUE"]);
    expect((await evaluerAlertes(MAINTENANT)).creees).toHaveLength(0);

    await enLigne();
    const apres = await evaluerAlertes(MAINTENANT);
    expect(apres.resolues).toBeGreaterThanOrEqual(1);
    expect((await alertes("BORNE_MUETTE"))[0].statut).toBe("RESOLUE");
  });

  it("n'alerte pas la nuit, ni juste après l'ouverture", async () => {
    await prisma.borne.update({ where: { id: borneId }, data: { dernierHeartbeat: new Date("2026-09-29T20:00:00Z") } });
    expect((await evaluerAlertes(new Date("2026-09-30T00:00:00Z"))).creees).toHaveLength(0); // 2 h du matin
    expect((await evaluerAlertes(new Date("2026-09-30T08:30:00Z"))).creees).toHaveLength(0); // 10 h 30 : ouvert depuis 30 min
  });

  it("n'alerte pas un lieu saisonnier hors saison", async () => {
    await prisma.lieu.update({
      where: { id: lieuId },
      data: { saisonnalite: "SAISONNIER", saisons: { create: { debut: new Date("2026-04-01T00:00:00Z"), fin: new Date("2026-09-15T00:00:00Z") } } },
    });
    await prisma.borne.update({ where: { id: borneId }, data: { dernierHeartbeat: ilYa(48) } });
    expect((await evaluerAlertes(MAINTENANT)).creees).toHaveLength(0);
  });

  it("respecte la règle réglée par l'admin", async () => {
    await api.put("/api/alertes/regles/BORNE_MUETTE").send({ actif: true, niveau: "WARNING", parametres: { heures: 5 } }).expect(200);
    await prisma.borne.update({ where: { id: borneId }, data: { dernierHeartbeat: ilYa(3) } });
    expect((await evaluerAlertes(MAINTENANT)).creees).toHaveLength(0);
    await prisma.borne.update({ where: { id: borneId }, data: { dernierHeartbeat: ilYa(5.5) } });
    expect((await evaluerAlertes(MAINTENANT)).creees.map((a) => a.niveau)).toEqual(["WARNING"]);
  });
});

describe("ventes", () => {
  it("zéro vente sur un créneau qui vend d'habitude, résolu à la reprise", async () => {
    await enLigne();
    // Les 4 mercredis précédents : 5 ventes entre 13 h et 16 h
    for (const j of ["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23"]) {
      await vendre([1, 2, 3, 4, 5].map((i) => [`${j}T14:${10 + i}:00`, 6] as [string, number]));
    }
    const r = await evaluerAlertes(MAINTENANT);
    expect(r.creees.map((a) => a.type)).toEqual(["ZERO_VENTE"]);

    await vendre([["2026-09-30T15:30:00", 6]]);
    await evaluerAlertes(MAINTENANT);
    expect((await alertes("ZERO_VENTE"))[0].statut).toBe("RESOLUE");
  });

  it("taux de refus élevé sur 24 h", async () => {
    await enLigne();
    await vendre([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`2026-09-30T1${i % 6}:00:00`, 6, "accepte"] as [string, number, "accepte"]),
      ...[1, 2, 3, 4].map((i) => [`2026-09-30T1${i}:30:00`, 6, "refuse"] as [string, number, "refuse"]),
    ]);
    const r = await evaluerAlertes(MAINTENANT);
    const refus = r.creees.find((a) => a.type === "TAUX_REFUS");
    expect(refus?.message).toContain("33 %");
  });

  it("baisse de CA par jour ouvert, critique sous 30 %", async () => {
    await enLigne();
    await caJournalier("2026-08-26", 28, 100); // 26/08 → 22/09 : 100 €/jour
    await caJournalier("2026-09-23", 7, 20); // 23/09 → 29/09 : 20 €/jour
    const baisse = (await evaluerAlertes(MAINTENANT)).creees.find((a) => a.type === "BAISSE_CA");
    expect(baisse?.niveau).toBe("CRITIQUE");
    expect((baisse?.valeurs as { ratioPct: number }).ratioPct).toBe(20);
  });

  it("pic suspect par rapport à la moyenne", async () => {
    await enLigne();
    await caJournalier("2026-09-01", 28, 100);
    await caJournalier("2026-09-29", 1, 900);
    const pic = (await evaluerAlertes(MAINTENANT)).creees.find((a) => a.type === "PIC_SUSPECT");
    expect(pic?.message).toContain("9 fois la moyenne");
  });

  it("ventes hors horaires (fiche à corriger)", async () => {
    await enLigne();
    await vendre([["2026-09-29T03:00:00", 6], ["2026-09-29T03:10:00", 6], ["2026-09-29T03:20:00", 6]]);
    const hors = (await evaluerAlertes(MAINTENANT)).creees.find((a) => a.type === "VENTE_HORS_HORAIRES");
    expect(hors?.niveau).toBe("INFO");
  });
});

describe("consommables", () => {
  it("alerte sous le seuil et se résout après recharge", async () => {
    await enLigne();
    await prisma.heartbeat.create({ data: { borneId, horodatage: ilYa(0.2), papierRestant: 20, rubanRestant: 200 } });
    expect((await evaluerAlertes(MAINTENANT)).creees.map((a) => a.type)).toEqual(["CONSOMMABLES"]);
    await prisma.heartbeat.create({ data: { borneId, horodatage: ilYa(0.1), papierRestant: 400, rubanRestant: 400 } });
    await evaluerAlertes(MAINTENANT);
    expect((await alertes("CONSOMMABLES"))[0].statut).toBe("RESOLUE");
  });
});

describe("notifications et droits", () => {
  it("prévient les bonnes personnes par le bon canal", async () => {
    const admin = await prisma.user.create({ data: { email: "admin@t.fr", nom: "A", prenom: "", role: "ADMIN", telephone: "06 12 34 56 78" } });
    await prisma.user.create({ data: { email: "tech@t.fr", nom: "T", prenom: "", role: "TECHNICIEN" } });
    const com = await prisma.user.create({ data: { email: "com@t.fr", nom: "C", prenom: "", role: "COMMERCIAL" } });
    await prisma.lieu.update({ where: { id: lieuId }, data: { commercialId: com.id } });

    await prisma.borne.update({ where: { id: borneId }, data: { dernierHeartbeat: ilYa(3) } });
    await notifierAlertes((await evaluerAlertes(MAINTENANT)).creees);
    const notifs = await prisma.notificationAlerte.findMany();
    // Critique : e-mail admin + technicien, SMS à l'admin (qui a un téléphone) ; pas le commercial
    expect(notifs.map((x) => `${x.canal}:${x.destinataire}`).sort()).toEqual(["EMAIL:admin@t.fr", "EMAIL:tech@t.fr", "SMS:06 12 34 56 78"]);
    expect(notifs[0].erreur).toContain("BREVO_API_KEY"); // pas d'envoi réel sans clé
    expect(admin).toBeDefined();
  });

  it("chacun ne voit que les alertes qui le concernent, et peut les traiter", async () => {
    await prisma.user.create({ data: { email: "tech@t.fr", nom: "T", prenom: "", role: "TECHNICIEN" } });
    const com = await prisma.user.create({ data: { email: "com@t.fr", nom: "C", prenom: "", role: "COMMERCIAL" } });
    await prisma.lieu.update({ where: { id: lieuId }, data: { commercialId: com.id } });
    await prisma.borne.update({ where: { id: borneId }, data: { dernierHeartbeat: ilYa(3) } });
    await caJournalier("2026-08-26", 28, 100);
    await caJournalier("2026-09-23", 7, 50);
    await evaluerAlertes(MAINTENANT);

    const types = async (email: string) =>
      (await api.get("/api/alertes").set("X-Dev-Utilisateur", email).expect(200)).body.map((a: { type: string }) => a.type).sort();
    expect(await types("tech@t.fr")).toEqual(["BORNE_MUETTE"]);
    expect(await types("com@t.fr")).toEqual(["BAISSE_CA"]);

    const baisse = (await alertes("BAISSE_CA"))[0];
    const r = (await api.patch(`/api/alertes/${baisse.id}`).set("X-Dev-Utilisateur", "com@t.fr").send({ statut: "PRISE_EN_CHARGE", commentaire: "Appel au gérant" }).expect(200)).body;
    expect(r).toMatchObject({ statut: "PRISE_EN_CHARGE", assigneeId: com.id, commentaire: "Appel au gérant" });
    const muette = (await alertes("BORNE_MUETTE"))[0];
    await api.patch(`/api/alertes/${muette.id}`).set("X-Dev-Utilisateur", "com@t.fr").send({ statut: "IGNOREE" }).expect(404);
  });
});
