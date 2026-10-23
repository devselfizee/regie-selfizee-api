import request from "supertest";
import { describe, expect, it } from "vitest";
import { creerApp } from "../src/app.js";
import { Limiteur } from "../src/lib/limiteur.js";
import { normaliserCode } from "../src/mes-photos/seances.js";

// Page publique « Mes photos » : sans base de données (recherche PikCloud simulée)
describe("code de séance", () => {
  it("accepte minuscules, espaces et tiret ; refuse I, L, O, 0, 1 et une longueur fausse", () => {
    expect(normaliserCode("k7px-2m")).toBe("K7PX2M");
    expect(normaliserCode(" K7P X2M ")).toBe("K7PX2M");
    expect(normaliserCode("K7PX2O")).toBeNull();
    expect(normaliserCode("K7PX21")).toBeNull();
    expect(normaliserCode("K7PX2")).toBeNull();
  });
});

describe("limiteur", () => {
  it("bloque au-delà du maximum puis libère après la fenêtre", () => {
    const l = new Limiteur(2, 1000);
    expect([l.essayer("a", 0), l.essayer("a", 10), l.essayer("a", 20)]).toEqual([true, true, false]);
    expect(l.essayer("b", 20)).toBe(true);
    expect(l.essayer("a", 1015)).toBe(true);
  });
});

describe("routes publiques", () => {
  it("code d'exemple → lien de la page souvenir ; code inconnu → message unique", async () => {
    const api = request(creerApp());
    const ok = (await api.post("/public/v1/mes-photos/code").send({ code: "k7px2m" }).expect(200)).body;
    expect(ok).toMatchObject({ simulation: true });
    expect(ok.url).toMatch(/^https:\/\/myevent\.selfizee\.fr\/p\/FJT5/);
    const ko = (await api.post("/public/v1/mes-photos/code").send({ code: "AAAAAA" }).expect(404)).body;
    expect(ko.message).toBe("On ne trouve pas ce code. Vérifie les six caractères.");
  });

  it("bloque après 10 essais de code", async () => {
    const api = request(creerApp());
    for (let i = 0; i < 10; i++) await api.post("/public/v1/mes-photos/code").set("X-Forwarded-For", "203.0.113.9").send({ code: "AAAAAA" });
    await api.post("/public/v1/mes-photos/code").set("X-Forwarded-For", "203.0.113.9").send({ code: "K7PX2M" }).expect(429);
  });

  it("même réponse pour toute adresse, sans connexion", async () => {
    const api = request(creerApp());
    const a = await api.post("/public/v1/mes-photos/lien").send({ email: "connu@exemple.fr" }).expect(202);
    const b = await api.post("/public/v1/mes-photos/lien").send({ email: "inconnu@exemple.fr" }).expect(202);
    expect(a.body).toEqual(b.body);
    await api.post("/public/v1/mes-photos/lien").send({ email: "pas-un-email" }).expect(400);
  });
});
