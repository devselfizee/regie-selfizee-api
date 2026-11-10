import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Plateforme RGPD branchée sur la Régie : lien chiffré par mail, lecture, export, rectification, effacement, mails
// paramétrables. Base simulée en mémoire (pas de Postgres sur le poste) : seules les requêtes utilisées sont reproduites.

type Ligne = Record<string, unknown>;
const b = vi.hoisted(() => {
  delete process.env.KEYCLOAK_URL; // utilisateur de développement : admin
  process.env.RGPD_SECRET = "secret-de-test-rgpd";
  process.env.SOUVENIR_API_SECRET = "secret-de-test-souvenir";
  process.env.RGPD_URL = "https://rgpd.exemple.fr";
  return {
    inscriptions: [] as Ligne[],
    medias: [] as Ligne[],
    modeles: [] as Ligne[],
    journal: [] as Ligne[],
    audit: [] as Ligne[],
    purges: [] as unknown[],
    envois: [] as { a: string | string[]; sujet: string; html: string; texte?: string }[],
  };
});

vi.mock("../src/lib/envoi.js", () => ({
  emailConfigure: () => true,
  envoyerEmail: async (a: string | string[], sujet: string, html: string, _pj: unknown, options: { texte?: string } = {}) => {
    b.envois.push({ a, sujet, html, texte: options.texte });
    return null;
  },
}));
vi.mock("../src/synchro-pikcloud/telechargement.js", () => ({ purgerMedia: async (m: { id: bigint }) => void b.purges.push(m.id) }));

vi.mock("../src/lib/prisma.js", () => {
  const corresp = (l: Ligne, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "OR") return (v as Ligne[]).some((w) => corresp(l, w));
      const x = l[k];
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const o = v as Record<string, unknown>;
        if ("not" in o) return o.not === null ? x !== null && x !== undefined : x !== o.not;
        if ("in" in o) return (o.in as unknown[]).includes(x);
        return false;
      }
      return v === null ? x == null : x === v;
    });
  // Relations lues par la plateforme : lieu, événement, carte (aucune ici)
  const complet = (i: Ligne) => ({ ...i, lieu: { enseigne: "La Ruche", ville: "Trégueux" }, evenement: { nom: i.codeEvent === "RHAL" ? "Halloween" : null }, carte: null });
  return {
    prisma: {
      souvenirInscription: {
        findMany: async ({ where }: { where: Ligne }) => b.inscriptions.filter((i) => corresp(i, where)).map(complet),
        findFirst: async ({ where }: { where: Ligne }) => {
          const i = b.inscriptions.find((x) => corresp(x, where));
          return i ? complet(i) : null;
        },
        count: async ({ where }: { where: Ligne }) => b.inscriptions.filter((i) => corresp(i, where)).length,
        update: async ({ where, data }: { where: { id: string }; data: Ligne }) => Object.assign(b.inscriptions.find((i) => i.id === where.id)!, data),
      },
      souvenirLivraison: { deleteMany: async () => ({ count: 0 }) },
      souvenirJournal: { create: async ({ data }: { data: Ligne }) => b.journal.push(data) },
      media: { findMany: async ({ where }: { where: Ligne }) => b.medias.filter((m) => corresp(m, where)) },
      modeleMail: {
        findUnique: async ({ where }: { where: { cle: string } }) => b.modeles.find((m) => m.cle === where.cle) ?? null,
        upsert: async ({ where, create, update }: { where: { cle: string }; create: Ligne; update: Ligne }) => {
          const m = b.modeles.find((x) => x.cle === where.cle);
          if (m) return Object.assign(m, update, { updatedAt: new Date() });
          b.modeles.push({ ...create, updatedAt: new Date(), modifiePar: null });
        },
        deleteMany: async ({ where }: { where: { cle: string } }) => {
          const avant = b.modeles.length;
          b.modeles = b.modeles.filter((m) => m.cle !== where.cle);
          return { count: avant - b.modeles.length };
        },
      },
      auditLog: { create: async ({ data }: { data: Ligne }) => b.audit.push(data) },
      user: { upsert: async () => ({ id: 1, email: "dev@local", nom: "Développeur", prenom: "", role: "ADMIN", lieuId: null, isActive: true }) },
    },
  };
});

const { creerApp } = await import("../src/app.js");
const { ecrireJetonAcces, lireJetonAcces } = await import("../src/rgpd/jeton.js");
const app = creerApp();

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const AUTRE = "44444444-4444-4444-8444-444444444444";
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MOI = "invite@exemple.fr";
const jeton = ecrireJetonAcces(MOI);
const attendre = () => new Promise((r) => setTimeout(r, 30)); // envois en arrière-plan

const inscription = (id: string, codeEvent: string, photoUuid: string, email: string | null, plus: Ligne = {}): Ligne => ({
  id, codeEvent, photoUuid, email, prenom: "Léa", optinLieu: true, optinSelfizee: false, ipTronquee: "90.12.34.0", userAgent: "Safari", lieuId: 7,
  createdAt: new Date("2026-10-31T21:14:00Z"), anonymiseeLe: null, ...plus,
});

beforeEach(() => {
  b.inscriptions = [
    inscription(ID1, "RA7K", UUID_A, MOI),
    inscription(ID2, "RA7K", UUID_B, MOI, { createdAt: new Date("2026-11-02T10:00:00Z") }),
    inscription(ID3, "RHAL", UUID_A, MOI),
    inscription(AUTRE, "RA7K", UUID_B, "ami@exemple.fr"), // photo de groupe : UUID_B demandée par deux personnes
  ];
  b.medias = [
    { id: 1n, uuid: "m-gif", codeEvent: "RA7K", photoUuid: UUID_A, mediaStatut: "TELECHARGE", mediaChemin: "a/anim.gif", vignetteChemin: null },
    { id: 2n, uuid: "m-photo", codeEvent: "RA7K", photoUuid: UUID_A, mediaStatut: "TELECHARGE", mediaChemin: "a/photo.jpg", vignetteChemin: "a/v.jpg" },
    { id: 3n, uuid: "m-b", codeEvent: "RA7K", photoUuid: UUID_B, mediaStatut: "TELECHARGE", mediaChemin: "b/photo.jpg", vignetteChemin: null },
  ];
  b.modeles = [];
  b.journal = [];
  b.audit = [];
  b.purges = [];
  b.envois = [];
});

describe("origines de la plateforme (CORS)", () => {
  it("slash final retiré, valeur vide ou absente : toutes les origines", async () => {
    const { originesRgpd } = await import("../src/app.js");
    expect(originesRgpd("https://rgpd.orkessidev.com/ , https://rgpd.orkessi.com")).toEqual(["https://rgpd.orkessidev.com", "https://rgpd.orkessi.com"]);
    expect(originesRgpd("")).toBe("*");
    expect(originesRgpd(" , ")).toBe("*");
    expect(originesRgpd(undefined)).toBe("*");
  });
});

describe("jeton du lien d'accès", () => {
  it("chiffré (l'adresse n'y paraît pas), relu tel quel, refusé s'il est modifié, expiré après 7 jours", () => {
    expect(Buffer.from(jeton, "base64url").toString("latin1")).not.toContain("invite");
    expect(lireJetonAcces(jeton)).toEqual({ email: MOI, expire: false });
    const touche = jeton.slice(0, 30) + (jeton[30] === "A" ? "B" : "A") + jeton.slice(31);
    expect(lireJetonAcces(touche)).toBeNull();
    expect(lireJetonAcces("e30")).toBeNull();
    // Triple base64 du booth : refusé
    expect(lireJetonAcces(Buffer.from(Buffer.from(Buffer.from('a:1:{s:5:"email";s:16:"invite@exemple.fr";}').toString("base64")).toString("base64")).toString("base64url"))).toBeNull();
    expect(lireJetonAcces(ecrireJetonAcces(MOI, Date.now() - 7 * 86_400_000 - 1000))).toEqual({ email: MOI, expire: true });
  });
});

describe("demande du lien (POST /rgpd/v1/inscription)", () => {
  it("adresse connue : mail avec le lien chiffré ; inconnue : rien ; même réponse dans les deux cas", async () => {
    const connue = await request(app).post("/rgpd/v1/inscription").send({ email: " Invite@Exemple.fr " }).expect(200);
    const inconnue = await request(app).post("/rgpd/v1/inscription").send({ email: "personne@exemple.fr" }).expect(200);
    expect(connue.body).toEqual(inconnue.body);
    await attendre();
    expect(b.envois).toHaveLength(1);
    expect(b.envois[0].a).toBe(MOI);
    const lien = /href="(https:\/\/rgpd\.exemple\.fr\/e\/inf\/([\w-]+))"/.exec(b.envois[0].html)!;
    expect(lireJetonAcces(lien[2])).toEqual({ email: MOI, expire: false });
    expect(b.envois[0].html).toContain("valable 7 jours");
    expect(b.envois[0].texte).toContain(`Accéder à mes données : ${lien[1]}`);
  });

  it("plus de 3 demandes par heure pour une adresse : même réponse, plus rien ne part ; adresse invalide : 400", async () => {
    for (let n = 0; n < 4; n++) await request(app).post("/rgpd/v1/inscription").send({ email: "limite@exemple.fr" }).expect(200);
    b.inscriptions.push(inscription("55555555-5555-4555-8555-555555555555", "RA7K", UUID_A, "limite@exemple.fr"));
    await request(app).post("/rgpd/v1/inscription").send({ email: "limite@exemple.fr" }).expect(200);
    await attendre();
    expect(b.envois).toHaveLength(0);
    await request(app).post("/rgpd/v1/inscription").send({ email: "pas-une-adresse" }).expect(400);
  });

  it("le mail suit le modèle réglé dans la Régie (texte nettoyé), sinon le texte par défaut", async () => {
    await request(app)
      .put("/api/modeles-mail/RGPD_ACCES")
      .send({ sujet: "Vos données, {{email}}", corps: '<p onclick="x()">Bonjour <script>alert(1)</script><b>{{email}}</b></p><p>Valable {{validite}}.</p>' })
      .expect(200);
    expect(b.audit).toHaveLength(1);
    await request(app).post("/rgpd/v1/inscription").send({ email: MOI }).expect(200);
    await attendre();
    const m = b.envois[0];
    expect(m.sujet).toBe(`Vos données, ${MOI}`);
    expect(m.html).toContain(`<p>Bonjour <b>${MOI}</b></p><p>Valable 7 jours.</p>`);
    expect(m.html).not.toContain("script");
    expect(m.html).not.toContain("onclick");
    // Pas de {{lien}} dans le modèle : le bouton est ajouté quand même
    expect(m.html).toMatch(/href="https:\/\/rgpd\.exemple\.fr\/e\/inf\/[\w-]+"[^>]*>Accéder à mes données/);

    const liste = (await request(app).get("/api/modeles-mail").expect(200)).body as { cle: string; parDefaut: boolean }[];
    expect(liste.map((x) => [x.cle, x.parDefaut])).toEqual([["RGPD_ACCES", false], ["RGPD_NOTIFICATION", true]]);
    await request(app).delete("/api/modeles-mail/RGPD_ACCES").expect(200);
    expect(b.modeles).toHaveLength(0);
    await request(app).put("/api/modeles-mail/RGPD_ACCES").send({ sujet: "x", corps: "<script>x</script>" }).expect(400);
    await request(app).put("/api/modeles-mail/RGPD_NOTIFICATION").send({ sujet: "x", corps: "<p>x</p>", destinataires: "dpo@selfizee.fr, pas-valide" }).expect(400);
    await request(app).put("/api/modeles-mail/INCONNU").send({ sujet: "x", corps: "<p>x</p>" }).expect(404);
  });
});

describe("lecture et export", () => {
  it("UserDataReport : un événement par code, une ligne par inscription, photo signée (la photo fixe plutôt que le GIF)", async () => {
    const r = (await request(app).get(`/rgpd/v1/informations/${jeton}`).expect(200)).body;
    expect(r).toMatchObject({ email: MOI, expired: false, mediaCount: 3, eventCount: 2 });
    expect(r.events.map((e: { id: string; name: string }) => [e.id, e.name])).toEqual([
      ["RA7K", "La Ruche (Trégueux)"],
      ["RHAL", "La Ruche (Trégueux) — Halloween"],
    ]);
    const rec = r.events[0].records.find((x: { id: string }) => x.id === ID1);
    expect(rec.date).toBe("31-10-2026 22:14");
    expect(rec.photoFull).toMatch(/\/souvenir\/v1\/fichiers\/m-photo\?exp=\d+&sig=[\w-]+$/);
    expect(rec.photo).toBe(`${rec.photoFull}&l=500`);
    expect(rec.fields).toEqual([
      { label: "Adresse e-mail", value: MOI },
      { label: "Prénom", value: "Léa", contactId: "prenom" },
      { label: "Recevoir les offres de La Ruche", value: "Oui", contactId: "optinLieu", options: ["Oui", "Non"] },
      { label: "Recevoir les actualités de Selfizee", value: "Non", contactId: "optinSelfizee", options: ["Oui", "Non"] },
    ]);
    expect(r.events[1].records[0].photo).toBeNull(); // RHAL : aucun média reçu
    expect(JSON.stringify(r)).not.toContain("ami@exemple.fr");
  });

  it("jeton faux : 404 ; expiré : { expired: true } sans donnée ; export CSV pour Excel", async () => {
    await request(app).get("/rgpd/v1/informations/pas-un-jeton-valide-pas-un-jeton-valide-xx").expect(404);
    const vieux = ecrireJetonAcces(MOI, Date.now() - 8 * 86_400_000);
    expect((await request(app).get(`/rgpd/v1/informations/${vieux}`).expect(200)).body).toEqual({ email: "", expired: true, mediaCount: 0, eventCount: 0, events: [] });
    await request(app).get(`/rgpd/v1/export/${vieux}`).expect(403);
    const csv = await request(app).get(`/rgpd/v1/export/${jeton}`).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["cache-control"]).toBe("no-store");
    expect(csv.text.startsWith("﻿Événement;")).toBe(true);
    expect(csv.text).toContain(`La Ruche (Trégueux);RA7K;31-10-2026 22:14;Prénom;Léa`);
    expect(csv.text).toContain(`Identifiant de la séance photo;${UUID_A}`);
  });
});

describe("rectification (POST /rgpd/v1/edition)", () => {
  it("prénom et consentements modifiés, journalisés, notifiés à l'équipe ; autres champs et autres adresses refusés", async () => {
    const r = await request(app)
      .post("/rgpd/v1/edition")
      .send({ token: jeton, photoId: ID1, fields: [{ contactId: "prenom", value: "Léna" }, { contactId: "optinLieu", value: "Non" }, { contactId: "optinSelfizee", value: "Non" }] })
      .expect(200);
    expect(r.body).toEqual({ error: false, updated: 2 });
    expect(b.inscriptions[0]).toMatchObject({ prenom: "Léna", optinLieu: false, optinSelfizee: false, email: MOI });
    expect(b.journal.at(-1)).toMatchObject({ evenement: "data_updated", details: { optinLieu: false } });
    await attendre();
    expect(b.envois).toHaveLength(1);
    expect(b.envois[0].a).toEqual(["dpo@selfizee.fr"]);
    expect(b.envois[0].sujet).toBe(`RGPD : modification des données de ${MOI}`);
    expect(b.envois[0].html).toContain("Prénom : « Léa » → « Léna »");

    await request(app).post("/rgpd/v1/edition").send({ token: jeton, photoId: ID1, fields: [{ contactId: "email", value: "x@y.fr" }] }).expect(400);
    await request(app).post("/rgpd/v1/edition").send({ token: jeton, photoId: ID1, fields: [{ contactId: "optinLieu", value: "Peut-être" }] }).expect(400);
    await request(app).post("/rgpd/v1/edition").send({ token: jeton, photoId: AUTRE, fields: [{ contactId: "prenom", value: "Pirate" }] }).expect(404);
    await request(app).post("/rgpd/v1/edition").send({ token: "faux", photoId: ID1, fields: [{ contactId: "prenom", value: "x" }] }).expect(403);
    expect(b.inscriptions[3].prenom).toBe("Léa");
  });

  it("sans destinataire réglé, aucune notification", async () => {
    await request(app).put("/api/modeles-mail/RGPD_NOTIFICATION").send({ sujet: "RGPD", corps: "<p>{{details}}</p>", destinataires: "" }).expect(200);
    await request(app).post("/rgpd/v1/edition").send({ token: jeton, photoId: ID1, fields: [{ contactId: "prenom", value: "Zoé" }] }).expect(200);
    await attendre();
    expect(b.envois).toHaveLength(0);
  });
});

describe("effacement (POST /rgpd/v1/suppression)", () => {
  it("« both » : données effacées et photo purgée si personne d'autre ne l'a demandée", async () => {
    const r = await request(app).post("/rgpd/v1/suppression").send({ token: jeton, photoId: ID1, target: "both" }).expect(200);
    expect(r.body).toEqual({ error: false, deleted: 1, photoKept: 0 });
    expect(b.inscriptions[0]).toMatchObject({ email: null, prenom: null, ipTronquee: null, userAgent: null });
    // RHAL a aussi UUID_A mais sous un autre code : seuls les médias de RA7K/UUID_A sont purgés
    expect(b.purges).toEqual([1n, 2n]);
    await attendre();
    expect(b.envois[0].sujet).toBe(`RGPD : suppression des données de ${MOI}`);
  });

  it("photo de groupe : « both » garde la photo, « photo » est refusé (409)", async () => {
    await request(app).post("/rgpd/v1/suppression").send({ token: jeton, photoId: ID2, target: "photo" }).expect(409);
    expect(b.purges).toEqual([]);
    const r = await request(app).post("/rgpd/v1/suppression").send({ token: jeton, photoId: ID2 }).expect(200);
    expect(r.body).toEqual({ error: false, deleted: 1, photoKept: 1 });
    expect(b.purges).toEqual([]);
    expect(b.inscriptions[1].email).toBeNull();
    expect(b.inscriptions[3].email).toBe("ami@exemple.fr");
  });

  it("« data » : prénom et traces effacés, consentements retirés, l'adresse reste ; « photo » seule : purge", async () => {
    await request(app).post("/rgpd/v1/suppression").send({ token: jeton, photoId: ID1, target: "data" }).expect(200);
    expect(b.inscriptions[0]).toMatchObject({ email: MOI, prenom: null, ipTronquee: null, userAgent: null, optinLieu: false, optinSelfizee: false });
    expect(b.purges).toEqual([]);
    await request(app).post("/rgpd/v1/suppression").send({ token: jeton, photoId: ID1, target: "photo" }).expect(200);
    expect(b.purges).toEqual([1n, 2n]);
    expect(b.inscriptions[0].email).toBe(MOI);
  });

  it("tout un événement : chaque inscription de l'adresse sur ce code ; jamais celles d'une autre adresse", async () => {
    const r = await request(app).post("/rgpd/v1/suppression").send({ token: jeton, eventId: "RA7K" }).expect(200);
    expect(r.body).toEqual({ error: false, deleted: 2, photoKept: 1 });
    expect(b.inscriptions.map((i) => i.email)).toEqual([null, null, MOI, "ami@exemple.fr"]);
    await request(app).post("/rgpd/v1/suppression").send({ token: jeton, eventId: "RA7K" }).expect(404);
    await request(app).post("/rgpd/v1/suppression").send({ token: jeton, photoId: AUTRE }).expect(404);
    await request(app).post("/rgpd/v1/suppression").send({ token: jeton }).expect(400);
  });
});
