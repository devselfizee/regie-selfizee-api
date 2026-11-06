import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reglagesParDefaut } from "../src/config-evenement/reglages.js";
import { tirerLot } from "../src/souvenir/donnees.js";
import { envoyerEnAttente, expediteur } from "../src/souvenir/envois.js";
import { mailLivraison } from "../src/souvenir/mails.js";
import { rattraperLivraisons } from "../src/souvenir/donnees.js";

// Ce que l'invité écrit sur la page souvenir, stocké dans la Régie : inscription, renvoi, livraison différée, carte à
// gratter avec un vrai code de remise, lien « Toutes tes photos », journal, export des contacts opt-in lieu.
// Base simulée en mémoire (pas de Postgres sur le poste) : seules les requêtes utilisées sont reproduites.

type Ligne = Record<string, unknown> & { id: unknown };
const b = vi.hoisted(() => {
  delete process.env.KEYCLOAK_URL; // utilisateur de développement : admin
  return {
    reglages: {} as unknown,
    medias: [] as Ligne[],
    inscriptions: [] as Ligne[],
    livraisons: [] as Ligne[],
    cartes: [] as Ligne[],
    codes: [] as Ligne[],
    lots: [] as Ligne[],
    liens: [] as Ligne[],
    journal: [] as Ligne[],
    audit: [] as Ligne[],
    n: 1,
    // Fournisseur de mails simulé : ce qui aurait été envoyé, et sa réponse (null = accepté)
    mailjet: false,
    reponseMailjet: null as string | null,
    envois: [] as { a: string; sujet: string; html: string; pj: { nom: string }[]; options: { idSuivi?: string; expediteur?: { email: string } } }[],
    codeSeance: "K7PX2M" as string | null,
  };
});

vi.mock("../src/lib/envoi.js", () => ({
  emailConfigure: () => b.mailjet,
  envoyerEmail: async (a: string, sujet: string, html: string, pj: { nom: string }[] = [], options = {}) => {
    b.envois.push({ a, sujet, html, pj, options });
    return b.reponseMailjet;
  },
}));

// Fichiers simulés : photo et GIF lisibles, rien n'est effacé du disque
vi.mock("../src/lib/stockage.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/stockage.js")>()),
  lireBuffer: async (c: string) => Buffer.alloc(c.endsWith(".gif") ? 2000 : 1000),
  supprimer: async () => undefined,
}));

// Séance telle que la lit la page (fichiers et grille simulés) ; l'état vient des médias de la base simulée
vi.mock("../src/souvenir/seance.js", async (orig) => {
  const vrai = await orig<typeof import("../src/souvenir/seance.js")>();
  type R = { lieu: { ton: "club"; avisGoogleUrl: string | null; instagram: string | null; tiktok: string | null; hashtag: string | null } };
  const evenementAffiche = async (code: string) =>
    code === "RA7K" ? { e: { id: 70, code, lieuId: 7, lieu: { enseigne: "La Ruche", ville: "Trégueux" } }, r: b.reglages as R } : null;
  const lireSeanceSouvenir = async (j: { code: string; photoUuid: string }, base: string) => {
    if (j.code !== "RA7K") return null;
    const l = (b.reglages as R).lieu;
    const dispo = b.medias.some((m) => m.photoUuid === j.photoUuid && m.mediaStatut === "TELECHARGE");
    return {
      token: `RA7K-${j.photoUuid.replace(/-/g, "")}`,
      evenement: {
        code: "RA7K", lieu: "La Ruche", ville: "Trégueux", jeu: { actif: true, lots: {}, maxLotsParJour: 50 }, reimpressionWeb: false,
        tarifs: { paliers: [{ from: 1, unitPrice: 5 }, { from: 2, unitPrice: 3.5 }] }, ton: l.ton,
        liens: { avisGoogle: l.avisGoogleUrl, instagram: l.instagram, tiktok: l.tiktok, hashtag: l.hashtag }, illustrations: [],
      },
      etat: dispo ? "disponible" : "en-attente",
      ...(b.codeSeance ? { codeSeance: b.codeSeance } : {}),
      ...(dispo ? { prisLe: "2026-10-19T21:42:00.000Z", visuels: [{ type: "photo", url: `${base}/souvenir/v1/fichiers/u?exp=1&sig=s`, largeur: 1, hauteur: 1 }] } : { visuels: [] }),
    };
  };
  return { ...vrai, evenementAffiche, lireSeanceSouvenir };
});

vi.mock("../src/lib/prisma.js", () => {
  const corresp = (l: Ligne, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      const x = l[k];
      if (v === null) return x === null || x === undefined;
      if (typeof v === "bigint") return BigInt(x as number) === v;
      if (k === "OR") return (v as Record<string, unknown>[]).some((w) => corresp(l, w));
      if (k === "livraisons") return b.livraisons.some((liv) => liv.inscriptionId === l.id && corresp(liv, (v as { some: Record<string, unknown> }).some));
      if (k === "inscription") return corresp(b.inscriptions.find((i) => i.id === l.inscriptionId)!, v as Record<string, unknown>);
      if (k === "codeRemise") return corresp(b.codes.find((c) => c.id === l.codeRemiseId) ?? ({ id: 0, utilise: 0 } as Ligne), v as Record<string, unknown>);
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const o = v as Record<string, unknown>;
        if ("not" in o) return o.not === null ? x !== null && x !== undefined : x !== o.not;
        if ("in" in o) return (o.in as unknown[]).includes(x);
        if ("gt" in o || "gte" in o || "lt" in o || "lte" in o) {
          const t = x instanceof Date ? x.getTime() : Number(x);
          const n = (d: unknown) => (d instanceof Date ? d.getTime() : Number(d));
          if (x === null || x === undefined) return false;
          return (!("gt" in o) || t > n(o.gt)) && (!("gte" in o) || t >= n(o.gte)) && (!("lt" in o) || t < n(o.lt)) && (!("lte" in o) || t <= n(o.lte));
        }
        return false;
      }
      return x === v;
    });
  const table = (rows: () => Ligne[], defauts: () => Record<string, unknown> = () => ({})) => ({
    findFirst: async ({ where, include, select }: { where?: Record<string, unknown>; include?: unknown; select?: unknown } = {}) => {
      const r = rows().filter((l) => corresp(l, where)).at(0);
      return r ? avec(r, include ?? select) : null;
    },
    findUnique: async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => {
      const r = rows().find((l) => corresp(l, where));
      return r ? avec(r, include) : null;
    },
    findUniqueOrThrow: async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => avec(rows().find((l) => corresp(l, where))!, include),
    findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number } = {}) => {
      const r = rows().filter((l) => corresp(l, where)).map((l) => avec(l, true));
      return take ? r.slice(0, take) : r;
    },
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => rows().filter((l) => corresp(l, where)).length,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const { livraisons, ...reste } = data as { livraisons?: { create: Record<string, unknown> }; id?: unknown };
      const l: Ligne = { id: reste.id ?? (rows() === b.inscriptions ? `00000000-0000-4000-8000-${String(b.n++).padStart(12, "0")}` : b.n++), createdAt: new Date(), ...defauts(), ...reste };
      if (rows() === b.cartes && rows().some((c) => c.inscriptionId === l.inscriptionId)) throw Object.assign(new Error("unique"), { code: "P2002" });
      rows().push(l);
      if (livraisons) b.livraisons.push({ id: b.n++, inscriptionId: l.id, renvoi: false, tentatives: 0, prochainEssai: null, erreur: null, createdAt: new Date(), ...livraisons.create });
      return avec(l, true);
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const l = rows().find((x) => corresp(x, where))!;
      for (const [k, v] of Object.entries(data)) l[k] = v && typeof v === "object" && "increment" in v ? Number(l[k]) + Number(v.increment) : v;
      return l;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = rows().filter((l) => corresp(l, where));
      r.forEach((l) => Object.assign(l, data));
      return { count: r.length };
    },
    deleteMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const r = rows().filter((l) => corresp(l, where));
      r.forEach((l) => rows().splice(rows().indexOf(l), 1));
      return { count: r.length };
    },
    groupBy: async ({ by, where }: { by: string[]; where?: Record<string, unknown> }) => {
      const g = new Map<unknown, number>();
      rows().filter((l) => corresp(l, where)).forEach((l) => g.set(l[by[0]], (g.get(l[by[0]]) ?? 0) + 1));
      return [...g].map(([k, n]) => ({ [by[0]]: k, _count: { _all: n } }));
    },
  });
  // Relations chargées comme le ferait Prisma (include / select imbriqués simplifiés)
  const avec = (l: Ligne, include: unknown) => {
    if (!include) return l;
    if ("email" in l && "photoUuid" in l && "estMoi" in l) {
      const carte = b.cartes.find((c) => c.inscriptionId === l.id);
      const code = carte && b.codes.find((c) => c.id === carte.codeRemiseId);
      return { ...l, livraisons: b.livraisons.filter((x) => x.inscriptionId === l.id), carte: carte ? { ...carte, codeRemise: code ? { code: code.code } : null } : null, evenement: { nom: null, habituel: true } };
    }
    if ("inscriptionId" in l && "renvoi" in l) return { ...l, inscription: b.inscriptions.find((i) => i.id === l.inscriptionId) };
    if ("lot" in l && "inscriptionId" in l) {
      const code = b.codes.find((c) => c.id === l.codeRemiseId);
      return { ...l, inscription: b.inscriptions.find((i) => i.id === l.inscriptionId), codeRemise: code ? { code: code.code } : null };
    }
    return l;
  };
  const prisma = {
    configEvenement: {
      findUnique: async ({ where }: { where: { code: string } }) => (where.code === "RA7K" ? { id: 70, lieuId: 7, reglages: b.reglages } : null),
      findFirst: async () => ({ code: "RA7K" }),
      findMany: async () => [{ id: 70, code: "RA7K", nom: null, habituel: true }],
    },
    media: table(() => b.medias),
    souvenirInscription: table(() => b.inscriptions, () => ({ anonymiseeLe: null })),
    souvenirLivraison: table(() => b.livraisons, () => ({ renvoi: false, tentatives: 0, prochainEssai: null, erreur: null })),
    souvenirCarte: table(() => b.cartes, () => ({ reveleeLe: null, mailEnvoyeLe: null, mailErreur: null, mailTentatives: 0, mailProchainEssai: null })),
    codeRemise: table(() => b.codes, () => ({ utilise: 0 })),
    lotCodesRemise: table(() => b.lots),
    souvenirLien: table(() => b.liens, () => ({ ouvertLe: null })),
    souvenirJournal: table(() => b.journal),
    auditLog: { create: async ({ data }: { data: Ligne }) => b.audit.push(data) },
    user: { upsert: async () => ({ id: 1, email: "dev@local", nom: "Dev", prenom: "", role: "ADMIN", lieuId: null, isActive: true, keycloakSub: null }) },
    lieu: { findUnique: async () => ({ id: 7 }) },
    $transaction: async (f: (db: unknown) => Promise<unknown>) => f(prisma),
  };
  return { prisma };
});

const { creerApp } = await import("../src/app.js");
const app = creerApp();
const SECRET = "secret-de-test";
const UUID = "3f9ac0e1b27d4c58a6e90d14b7c2f581";
const TOKEN = `RA7K-${UUID}`;
const UUID_CANON = "3f9ac0e1-b27d-4c58-a6e9-0d14b7c2f581";
const srv = {
  post: (url: string, corps?: object) => request(app).post(`/souvenir/v1${url}`).set("X-Souvenir-Token", SECRET).send(corps ?? {}),
  get: (url: string) => request(app).get(`/souvenir/v1${url}`).set("X-Souvenir-Token", SECRET),
};
const TEXTES = ["C'est bien moi sur la photo.", "Les bons plans de La Ruche. Soirées et événements du lieu, par e-mail.", "Les nouveautés Selfizee. Quelques mails par an."];
const corps = (email: string, o: Partial<{ optinLieu: boolean; ip: string }> = {}) => ({
  email, prenom: "Lou", estMoi: true, optinLieu: o.optinLieu ?? false, optinSelfizee: false, textes: TEXTES, ip: o.ip ?? "10.0.0.0", userAgent: "Test",
});
const photoArrivee = () => b.medias.push({ id: 1, lieuId: 7, codeEvent: "RA7K", photoUuid: UUID_CANON, test: false, mediaStatut: "TELECHARGE", mediaChemin: "00/x.jpg", dateSave: new Date(), datePhoto: null, createdAt: new Date() });

beforeEach(() => {
  process.env.SOUVENIR_API_SECRET = SECRET;
  const r = reglagesParDefaut({ enseigne: "La Ruche", ville: "Trégueux", dateInstallation: null });
  r.tarifs.jeu = { actif: true, lots: { free: 0, pct50: 0, pct30: 1, none: 0 }, maxLotsParJour: 50 };
  b.reglages = r;
  for (const k of ["medias", "inscriptions", "livraisons", "cartes", "codes", "lots", "liens", "journal", "audit"] as const) b[k] = [];
  b.envois = [];
  b.mailjet = false;
  b.reponseMailjet = null;
  b.codeSeance = "K7PX2M";
});

describe("tirage du lot", () => {
  it("suit les poids, et ne donne rien au-delà du plafond du jour ou sans poids", () => {
    const lots = { free: 5, pct50: 10, pct30: 35, none: 50 };
    expect(tirerLot(lots, false, () => 0)).toBe("free");
    expect(tirerLot(lots, false, () => 5)).toBe("pct50");
    expect(tirerLot(lots, false, () => 15)).toBe("pct30");
    expect(tirerLot(lots, false, () => 50)).toBe("none");
    expect(tirerLot(lots, true, () => 0)).toBe("none");
    expect(tirerLot({ free: 0, pct50: 0, pct30: 0, none: 0 }, false)).toBe("none");
  });
});

describe("inscription « Recevoir mes photos »", () => {
  it("photo pas encore là : inscription enregistrée avec les textes, livraison en attente, puis débloquée à l'arrivée", async () => {
    const r = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("Lou@Exemple.fr", { optinLieu: true })).expect(201);
    expect(r.body).toMatchObject({ token: TOKEN, email: "lou@exemple.fr", prenom: "Lou", optinLieu: true, envois: [] });
    expect(r.body).not.toHaveProperty("ipTronquee");
    expect(b.inscriptions[0]).toMatchObject({ textes: TEXTES, ipTronquee: "10.0.0.0", lieuId: 7, configEvenementId: 70 });
    expect(b.livraisons[0]).toMatchObject({ etat: "EN_ATTENTE_MEDIA" });

    photoArrivee();
    const apres = await srv.get(`/seances/${TOKEN}/inscriptions/${r.body.id}`).expect(200);
    expect(apres.body.envois).toHaveLength(1);
    expect(b.livraisons[0].etat).toBe("A_ENVOYER");
    expect(b.journal.map((j) => j.evenement)).toEqual(["registered", "mail_sent"]);
    expect(JSON.stringify(b.journal)).not.toMatch(/exemple\.fr|10\.0\.0/);
  });

  it("même adresse sur la même séance : renvoi, pas de doublon ; « C'est bien moi » obligatoire ; 5 par IP et par heure", async () => {
    photoArrivee();
    const a = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("a@exemple.fr")).expect(201);
    const a2 = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("a@exemple.fr")).expect(201);
    expect(a2.body.id).toBe(a.body.id);
    expect(b.inscriptions).toHaveLength(1);
    expect(a2.body.envois).toHaveLength(2);
    await srv.post(`/seances/${TOKEN}/inscriptions`, { ...corps("b@exemple.fr"), estMoi: false }).expect(400);
    for (const e of ["b", "c", "d", "e"]) await srv.post(`/seances/${TOKEN}/inscriptions`, corps(`${e}@exemple.fr`)).expect(201);
    const trop = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("f@exemple.fr")).expect(422);
    expect(trop.body.message).toMatch(/Trop de demandes/);
    await srv.post(`/seances/${TOKEN}/inscriptions`, corps("f@exemple.fr", { ip: "10.0.1.0" })).expect(201);
  });

  it("refuse sans le secret, pour un événement inconnu ou une séance d'une autre inscription", async () => {
    await request(app).post(`/souvenir/v1/seances/${TOKEN}/inscriptions`).send(corps("a@exemple.fr")).expect(401);
    await srv.post(`/seances/RZZZ-${UUID}/inscriptions`, corps("a@exemple.fr")).expect(422);
    const a = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("a@exemple.fr")).expect(201);
    await srv.get(`/seances/RA7K-${"ab".repeat(16)}/inscriptions/${a.body.id}`).expect(404);
  });

  it("« Renvoyer » : 3 fois par heure au plus", async () => {
    photoArrivee();
    const a = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("a@exemple.fr")).expect(201);
    for (let i = 0; i < 3; i++) await srv.post(`/seances/${TOKEN}/inscriptions/${a.body.id}/renvoi`).expect(204);
    expect((await srv.post(`/seances/${TOKEN}/inscriptions/${a.body.id}/renvoi`).expect(422)).body.message).toMatch(/trois fois/);
  });
});

describe("carte à gratter", () => {
  it("lot tiré côté serveur, une fois par inscription, avec un vrai code de remise valable 30 jours sur toutes les bornes", async () => {
    photoArrivee();
    const a = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("a@exemple.fr")).expect(201);
    const c = await srv.post(`/seances/${TOKEN}/inscriptions/${a.body.id}/carte`).expect(200);
    expect(c.body).toMatchObject({ lot: "pct30", revelee: false });
    expect(c.body.code).toMatch(/^[A-HJKMNP-Z2-9]{5}$/);
    expect(b.codes).toHaveLength(1);
    expect(b.lots[0]).toMatchObject({ type: "POURCENTAGE", pourcentage: 30, quantite: 1, seulementLieu: false, lieuId: 7, nbCodes: 1 });
    const jours = ((b.lots[0].expireLe as Date).getTime() - Date.now()) / 86_400_000;
    expect(jours).toBeGreaterThan(28);
    expect(jours).toBeLessThan(31);
    // Second passage : la même carte, aucun nouveau code
    const c2 = await srv.post(`/seances/${TOKEN}/inscriptions/${a.body.id}/carte`).expect(200);
    expect(c2.body.code).toBe(c.body.code);
    expect(b.codes).toHaveLength(1);
    await srv.post(`/seances/${TOKEN}/inscriptions/${a.body.id}/revelation`).expect(204);
    expect((await srv.get(`/seances/${TOKEN}/inscriptions/${a.body.id}`)).body.carte).toMatchObject({ lot: "pct30", revelee: true, code: c.body.code });
  });

  it("jeu coupé ou plafond du jour atteint : « pas cette fois », sans code", async () => {
    photoArrivee();
    (b.reglages as { tarifs: { jeu: { maxLotsParJour: number } } }).tarifs.jeu.maxLotsParJour = 0;
    const a = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("a@exemple.fr")).expect(201);
    expect((await srv.post(`/seances/${TOKEN}/inscriptions/${a.body.id}/carte`).expect(200)).body).toEqual({ lot: "none", revelee: false });
    expect(b.codes).toHaveLength(0);
  });
});

describe("lien « Toutes tes photos »", () => {
  it("créé seulement pour une adresse livrée, rendu en recette, à usage unique (une heure de grâce)", async () => {
    photoArrivee();
    await srv.post(`/seances/${TOKEN}/inscriptions`, corps("a@exemple.fr")).expect(201);
    expect((await srv.post("/liens", { email: "inconnu@exemple.fr" }).expect(202)).body).toEqual({});
    expect((await srv.post("/liens", { email: "a@exemple.fr" }).expect(202)).body).toEqual({}); // hors recette : jamais rendu
    expect(b.liens).toHaveLength(1);
    expect(b.liens[0].jetonHash).toMatch(/^[0-9a-f]{64}$/);
    process.env.SOUVENIR_SEANCES_TEST = "1";
    try {
      const { recette } = (await srv.post("/liens", { email: "a@exemple.fr" }).expect(202)).body;
      const m = await srv.get(`/liens/${recette}`).expect(200);
      expect(m.body).toEqual({ email: "a@exemple.fr", tokens: [TOKEN] });
      b.liens.at(-1)!.ouvertLe = new Date(Date.now() - 2 * 3_600_000);
      await srv.get(`/liens/${recette}`).expect(404);
    } finally {
      delete process.env.SOUVENIR_SEANCES_TEST;
    }
  });
});

describe("journal de la page", () => {
  it("garde l'événement, la séance et le lieu, jamais de donnée personnelle", async () => {
    await srv.post("/journal", { evenement: "page_view", token: TOKEN, details: { email: "a@exemple.fr", index: 2 } }).expect(204);
    expect(b.journal[0]).toMatchObject({ evenement: "page_view", codeEvent: "RA7K", photoUuid: UUID_CANON, lieuId: 7, details: { index: 2 } });
    await srv.post("/journal", { evenement: "piratage", token: TOKEN }).expect(400);
  });
});

describe("fiche lieu : entonnoir et contacts opt-in lieu", () => {
  it("compte l'entonnoir et n'exporte que les opt-in lieu, export tracé", async () => {
    photoArrivee();
    await srv.post("/journal", { evenement: "page_view", token: TOKEN }).expect(204);
    await srv.post(`/seances/${TOKEN}/inscriptions`, corps("oui@exemple.fr", { optinLieu: true })).expect(201);
    await srv.post(`/seances/${TOKEN}/inscriptions`, corps("non@exemple.fr")).expect(201);
    const r = await request(app).get("/api/lieux/7/souvenir/resume").expect(200);
    expect(r.body).toMatchObject({ seances: 1, scans: 1, inscriptions: 2, optinsLieu: 1, livraisons: { aEnvoyer: 2 } });
    const c = await request(app).get("/api/lieux/7/souvenir/contacts").expect(200);
    expect(c.body.contacts.map((x: { email: string }) => x.email)).toEqual(["oui@exemple.fr"]);
    expect(c.body.contacts[0].texteAccepte).toBe(TEXTES[1]);
    const csv = await request(app).get("/api/lieux/7/souvenir/contacts.csv").expect(200);
    expect(csv.text).toContain("oui@exemple.fr");
    expect(csv.text).not.toContain("non@exemple.fr");
    expect(b.audit[0]).toMatchObject({ action: "EXPORT_CONTACTS_SOUVENIR", entiteId: "7" });
  });
});

describe("mails de la page souvenir (Mailjet simulé)", () => {
  const avecMails = () => {
    b.mailjet = true;
    process.env.SOUVENIR_URL_FICHIERS = "https://api.test";
    process.env.SOUVENIR_PAGE_URL = "https://souvenir.test";
    process.env.MAILJET_WEBHOOK_SECRET = "cle-webhook";
  };
  const gifArrive = () => b.medias.push({ id: 2, lieuId: 7, codeEvent: "RA7K", photoUuid: UUID_CANON, test: false, mediaStatut: "TELECHARGE", mediaChemin: "00/x.gif", dateSave: new Date(), datePhoto: null, createdAt: new Date() });
  const sansEsperluettes = (u: string) => u.replace(/&amp;/g, "&");

  it("expéditeur : SENDER_SELFIZEE, adresse seule ou « Nom <adresse> »", () => {
    expect(expediteur("Selfizee Photos <photos@selfizee.fr>")).toEqual({ email: "photos@selfizee.fr", nom: "Selfizee Photos" });
    expect(expediteur("bonjour@selfizee.fr")).toEqual({ email: "bonjour@selfizee.fr", nom: "Selfizee" });
    expect(expediteur(undefined)).toEqual({ email: "photos@selfizee.fr", nom: "Selfizee" });
  });

  it("mail 1 : photo et GIF en pièces jointes, code, avis, réseaux, « Supprimer mes photos » ; clic suivi ; rebond dur → « échec »", async () => {
    avecMails();
    process.env.SENDER_SELFIZEE = "Selfizee <photos@selfizee.fr>";
    const r = b.reglages as { lieu: { avisGoogleUrl: string | null; instagram: string | null } };
    r.lieu.avisGoogleUrl = "https://g.page/r/la-ruche/review";
    r.lieu.instagram = "@laruche";
    photoArrivee();
    gifArrive();
    const a = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("lou@exemple.fr")).expect(201);
    await envoyerEnAttente();
    expect(b.envois).toHaveLength(1);
    const m = b.envois[0];
    expect(m).toMatchObject({ a: "lou@exemple.fr", sujet: "Tes photos de La Ruche sont là" });
    expect(m.options).toMatchObject({ expediteur: { email: "photos@selfizee.fr" }, idSuivi: `souvenir-l-${b.livraisons[0].id}` });
    expect(m.pj.map((p) => p.nom)).toEqual(["selfizee-la-ruche-2026-10-19.jpg", "anim.gif"]);
    expect(m.html).toContain("Ta photo et ton GIF sont en pièces jointes.");
    expect(m.html).toContain(`/p/${TOKEN}"`); // même lien que le QR imprimé (SOUVENIR_QR_BASE_URL)
    expect(m.html).toContain("K7PX2M");
    expect(m.html).toContain("Dès 3,50");
    expect(m.html).toContain("Je laisse mon avis");
    expect(m.html).toContain("https://api.test/souvenir/v1/fichiers/u?exp=1&amp;sig=s&amp;l=500");
    expect(m.html).toContain("https://souvenir.test/forget/");
    expect(m.html).toContain("La Ruche, Trégueux, le 19 octobre 2026");
    expect(b.livraisons[0]).toMatchObject({ etat: "ENVOYE" });

    // « Je laisse mon avis » : compté, puis redirigé vers l'avis Google réglé dans la Régie
    const avis = sansEsperluettes(/href="(https:\/\/api\.test\/souvenir\/v1\/r\/avis\/[^"]+)"/.exec(m.html)![1]).replace("https://api.test", "");
    const redir = await request(app).get(avis).expect(302);
    expect(redir.headers.location).toBe("https://g.page/r/la-ruche/review");
    expect(b.journal.some((j) => j.evenement === "review_click")).toBe(true);
    await request(app).get(avis.replace(/sig=[^&]+/, "sig=faux")).expect(404);
    const insta = sansEsperluettes(/href="(https:\/\/api\.test\/souvenir\/v1\/r\/instagram\/[^"]+)"/.exec(m.html)![1]).replace("https://api.test", "");
    expect((await request(app).get(insta).expect(302)).headers.location).toBe("https://www.instagram.com/laruche/");

    // Rebond dur signalé par Mailjet
    const evt = [{ event: "bounce", hard_bounce: true, error_related_to: "recipient", error: "user unknown", CustomID: m.options.idSuivi }];
    await request(app).post("/webhooks/v1/mailjet").send(evt).expect(401);
    await request(app).post("/webhooks/v1/mailjet?cle=cle-webhook").send(evt).expect(200);
    expect(b.livraisons[0]).toMatchObject({ etat: "ECHEC" });
    expect((await srv.get(`/seances/${TOKEN}/inscriptions/${a.body.id}`).expect(200)).body.echec).toBe(true);
    delete process.env.SENDER_SELFIZEE;
  });

  it("refus du fournisseur : réessais espacés, puis « échec » sans accuser l'adresse ; sans Mailjet, rien ne part", async () => {
    photoArrivee();
    const a = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("lou@exemple.fr")).expect(201);
    await envoyerEnAttente();
    expect(b.envois).toHaveLength(0);
    expect(b.livraisons[0].etat).toBe("A_ENVOYER");

    avecMails();
    b.reponseMailjet = "Mailjet 503 : indisponible";
    await envoyerEnAttente();
    expect(b.envois).toHaveLength(1);
    expect(b.livraisons[0]).toMatchObject({ etat: "A_ENVOYER", tentatives: 1 });
    expect((b.livraisons[0].prochainEssai as Date).getTime()).toBeGreaterThan(Date.now());
    await envoyerEnAttente();
    expect(b.envois).toHaveLength(1);
    Object.assign(b.livraisons[0], { tentatives: 5, prochainEssai: new Date(Date.now() - 1000) });
    await envoyerEnAttente();
    expect(b.livraisons[0]).toMatchObject({ etat: "ECHEC", erreur: "Mailjet 503 : indisponible" });
    expect((await srv.get(`/seances/${TOKEN}/inscriptions/${a.body.id}`).expect(200)).body.echec).toBe(false);
  });

  it("mail 2 : code gagné envoyé une fois, à la révélation de la carte", async () => {
    avecMails();
    photoArrivee();
    const a = await srv.post(`/seances/${TOKEN}/inscriptions`, corps("lou@exemple.fr")).expect(201);
    const carte = (await srv.post(`/seances/${TOKEN}/inscriptions/${a.body.id}/carte`).expect(200)).body;
    await envoyerEnAttente();
    expect(b.envois.map((e) => e.sujet)).toEqual(["Tes photos de La Ruche sont là"]);
    await srv.post(`/seances/${TOKEN}/inscriptions/${a.body.id}/revelation`).expect(204);
    await envoyerEnAttente();
    expect(b.envois.map((e) => e.sujet)).toEqual(["Tes photos de La Ruche sont là", "Gagné : -30 % sur ta prochaine photo"]);
    expect(b.envois[1].html).toContain(carte.code);
    expect(b.envois[1].html).toContain("https://souvenir.test/illustrations/illus-1.jpg");
    expect(b.cartes[0].mailEnvoyeLe).toBeInstanceOf(Date);
    await envoyerEnAttente();
    expect(b.envois).toHaveLength(2);
  });

  it("photo introuvable 24 h après l'inscription : mail, puis livraison si elle finit par arriver", async () => {
    avecMails();
    await srv.post(`/seances/${TOKEN}/inscriptions`, corps("lou@exemple.fr")).expect(201);
    await envoyerEnAttente();
    expect(b.envois).toHaveLength(0);
    b.livraisons[0].createdAt = new Date(Date.now() - 25 * 3_600_000);
    await envoyerEnAttente();
    expect(b.envois.map((e) => e.sujet)).toEqual(["On n'a pas retrouvé ta photo"]);
    expect(b.livraisons[0].etat).toBe("PHOTO_INTROUVABLE");
    photoArrivee();
    expect(await rattraperLivraisons()).toBe(1);
    await envoyerEnAttente();
    expect(b.envois.map((e) => e.sujet)).toEqual(["On n'a pas retrouvé ta photo", "Tes photos de La Ruche sont là"]);
  });

  it("mail 3 : le lien « Toutes tes photos » part seulement vers une adresse livrée", async () => {
    avecMails();
    photoArrivee();
    await srv.post(`/seances/${TOKEN}/inscriptions`, corps("lou@exemple.fr")).expect(201);
    await envoyerEnAttente();
    await srv.post("/liens", { email: "inconnu@exemple.fr" }).expect(202);
    await srv.post("/liens", { email: "lou@exemple.fr" }).expect(202);
    await vi.waitFor(() => expect(b.envois).toHaveLength(2));
    expect(b.envois.map((e) => e.a)).toEqual(["lou@exemple.fr", "lou@exemple.fr"]);
    expect(b.envois[1]).toMatchObject({ sujet: "Toutes tes photos Selfizee" });
    expect(b.envois[1].html).toMatch(/https:\/\/souvenir\.test\/mine\/[A-Za-z0-9_-]{30,}/);
    expect(b.envois[1].html).toContain("1 photo sur 90 jours");
  });

  it("« Supprimer mes photos » : lien signé ; l'e-mail seul si d'autres ont demandé la photo, sinon les fichiers aussi", async () => {
    avecMails();
    photoArrivee();
    await srv.post(`/seances/${TOKEN}/inscriptions`, corps("lou@exemple.fr")).expect(201);
    await srv.post(`/seances/${TOKEN}/inscriptions`, corps("max@exemple.fr")).expect(201);
    await envoyerEnAttente();
    const jetons = b.envois.map((e) => /https:\/\/souvenir\.test\/forget\/([^"]+)"/.exec(e.html)![1]);
    await srv.get(`/oubli/${jetons[0].slice(0, -3)}abc`).expect(404);
    await request(app).get(`/souvenir/v1/oubli/${jetons[0]}`).expect(401);

    expect((await srv.get(`/oubli/${jetons[0]}`).expect(200)).body).toMatchObject({ seule: false });
    expect((await srv.post(`/oubli/${jetons[0]}`).expect(200)).body).toEqual({ photosEffacees: false });
    expect(b.inscriptions[0]).toMatchObject({ email: null, prenom: null, ipTronquee: null });
    expect(b.medias[0].mediaStatut).toBe("TELECHARGE");
    await srv.get(`/oubli/${jetons[0]}`).expect(404);

    expect((await srv.get(`/oubli/${jetons[1]}`).expect(200)).body).toMatchObject({ seule: true });
    expect((await srv.post(`/oubli/${jetons[1]}`).expect(200)).body).toEqual({ photosEffacees: true });
    expect(b.medias[0]).toMatchObject({ mediaStatut: "PURGE", mediaChemin: null });
    expect(JSON.stringify(b.journal.filter((j) => j.evenement === "data_deleted"))).not.toMatch(/exemple\.fr/);
  });

  it("gabarit : sans code de séance ni lien d'avis, ni bloc de réimpression ni bloc avis ; tout est échappé", () => {
    const m = mailLivraison({
      lieu: "<b>Bar</b>", ville: "", date: new Date("2026-10-19T21:42:00Z"), page: "https://p.test/p/X", instagram: "https://i.test", tiktok: "https://t.test",
      hashtag: "@selfizee", avecGif: false, pied: { logo: "https://p.test/selfizee.png", viePrivee: "https://p.test/vie-privee", raison: "r" },
    });
    expect(m.html).not.toContain("Réimprime ta photo");
    expect(m.html).not.toContain("Je laisse mon avis");
    expect(m.html).not.toContain("<b>Bar</b>");
    expect(m.html).toContain("&lt;b&gt;Bar&lt;/b&gt;");
    expect(m.html).toContain("Ta photo est en pièce jointe.");
    expect(m.texte).toContain("https://p.test/p/X");
  });
});
