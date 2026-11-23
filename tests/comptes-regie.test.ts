import { afterEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { realmDeLEmetteur } from "../src/middleware/auth.js";
import { estAdminPlateforme, peutVoirTout, userCan } from "../src/middleware/permissions.js";
import { droitsDuProfil, grantsRegie, libellesDe, profilsClientsAutorises, viderCacheProfils } from "../src/permissions/droitsProfils.js";
import { lieuxDuCompteRegie, perimetreLieux } from "../src/middleware/utilisateur.js";
import { utilisateurSuperAdmin } from "../src/lib/superAdmin.js";
import { sorteConnexion } from "../src/routes/connexion.js";

// Comptes clients de la Régie, realm « regie » (option 2 du 20/11/2026)

describe("jeton : realm d'après l'émetteur", () => {
  const acceptes = new Map([
    ["https://auth/realms/konitys", { realm: "konitys" as const }],
    ["https://auth/realms/regie", { realm: "regie" as const }],
  ]);
  it("salarié, client, ou refusé", () => {
    expect(realmDeLEmetteur("https://auth/realms/konitys", acceptes)).toBe("konitys");
    expect(realmDeLEmetteur("https://auth/realms/regie", acceptes)).toBe("regie");
    expect(realmDeLEmetteur("https://auth/realms/autre", acceptes)).toBeNull();
    expect(realmDeLEmetteur(undefined, acceptes)).toBeNull();
  });
});

const requete = (o: { regie?: boolean; droits?: string; jeton?: string; profilId?: number }) =>
  ({
    realm: o.regie ? "regie" : undefined,
    header: (n: string) => (n.toLowerCase() === "x-dev-droits" ? o.droits : undefined),
    headers: o.jeton ? { authorization: `Bearer ${o.jeton}` } : {},
    utilisateur: { profilId: o.profilId ?? null },
  }) as unknown as Request;

describe("droits d'un compte régie : refus par défaut", () => {
  it("sans Keycloak (dev) : rien sans X-Dev-Droits, jamais admin ni « tous les lieux »", async () => {
    expect(await userCan(requete({ regie: true }), "ventes.view")).toBe(false);
    expect(await userCan(requete({ regie: true, droits: "ventes.view" }), "ventes.view")).toBe(true);
    expect(await userCan(requete({ regie: true, droits: "*" }), "ventes.view")).toBe(false);
    expect(await peutVoirTout(requete({ regie: true, droits: "lieux.view_any" }), "lieux.view_any")).toBe(false);
    expect(await estAdminPlateforme(requete({ regie: true }))).toBe(false);
    // Un salarié garde le comportement actuel : tout autorisé sans en-tête
    expect(await userCan(requete({}), "ventes.view")).toBe(true);
  });

  describe("avec Keycloak, gateway non configuré", () => {
    const avant = { kc: process.env.KEYCLOAK_URL, gw: process.env.KONITYS_GATEWAY_URL };
    afterEach(() => {
      if (avant.kc === undefined) delete process.env.KEYCLOAK_URL;
      else process.env.KEYCLOAK_URL = avant.kc;
      if (avant.gw === undefined) delete process.env.KONITYS_GATEWAY_URL;
      else process.env.KONITYS_GATEWAY_URL = avant.gw;
      viderCacheProfils();
    });
    it("le salarié passe (fail-open, inchangé), le compte régie n'a aucun droit", async () => {
      process.env.KEYCLOAK_URL = "https://auth.invalid";
      delete process.env.KONITYS_GATEWAY_URL;
      expect(await userCan(requete({ jeton: "abc" }), "ventes.view")).toBe(true);
      expect(await userCan(requete({ regie: true, jeton: "abc", profilId: 12 }), "ventes.view")).toBe(false);
      expect(await userCan(requete({ regie: true, jeton: "abc" }), "app.access")).toBe(false);
    });
  });
});

describe("droits d'un profil de l'Admin Panel", () => {
  afterEach(() => viderCacheProfils());

  // Forme confirmée par la plateforme le 23/11/2026 : data.direct (true | false) et data.inherited (listes de profils source)
  const reponse = {
    data: {
      direct: { regie: { "app.access": true, "paiements.view": false }, bornes: { x: true } },
      inherited: { regie: { "ventes.view": [{ id: 12, name: "Client – chiffres" }], "exports.view": [] }, bornes: { y: [{ id: 1, name: "?" }] } },
    },
  };

  it("droits effectifs : vrais en direct ou présents en hérité, seulement l'app regie", () => {
    expect(grantsRegie(reponse)).toEqual({ "app.access": true, "ventes.view": true });
    // Profil inexistant : direct {} sans 404 → aucun droit ; réponses inattendues : aucun droit
    expect(grantsRegie({ data: { direct: {}, inherited: {} } })).toEqual({});
    expect(grantsRegie({ data: [] })).toEqual({});
    expect(grantsRegie(null)).toEqual({});
  });

  it("lit le profil une fois (les hérités sont déjà calculés par le gateway) et garde en cache", async () => {
    const appels: string[] = [];
    const lire = async (c: string) => {
      appels.push(c);
      return reponse;
    };
    expect(await droitsDuProfil(1, lire)).toEqual({ "app.access": true, "ventes.view": true });
    expect(await droitsDuProfil(1, lire)).toEqual({ "app.access": true, "ventes.view": true });
    expect(appels).toEqual(["/api/permissions/profiles/1/permissions"]);
  });

  it("droits illisibles : null (le compte n'a alors aucun droit)", async () => {
    expect(await droitsDuProfil(9, async () => Promise.reject(new Error("HTTP 401")))).toBeNull();
  });

  it("noms des profils et profils autorisés pour les clients", () => {
    expect(libellesDe({ data: [{ id: 3, name: "Client – chiffres" }, { id: "x", name: "?" }] })).toEqual({ 3: "Client – chiffres" });
    expect(profilsClientsAutorises("12, 14;12 abc")).toEqual([12, 14]);
    expect(profilsClientsAutorises(undefined)).toEqual([]);
  });
});

describe("périmètre d'un compte régie", () => {
  it("lieux cochés parmi ceux de l'entreprise ; aucun coché = tous ceux de l'entreprise", () => {
    expect(lieuxDuCompteRegie([1, 2, 9], [1, 2, 3])).toEqual([1, 2]);
    expect(lieuxDuCompteRegie([], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(lieuxDuCompteRegie([9], [])).toEqual([]);
  });

  it("jamais « ceux dont il est le commercial », même sans lieu", () => {
    const u = { id: 5, email: "a@b.fr", nom: "", prenom: "", role: "PARTENAIRE" as const, voitTousLieux: false, lieuIds: [], compte: "REGIE" as const };
    expect(perimetreLieux(u)).toEqual({ lieuIds: [] });
    expect(perimetreLieux({ ...u, compte: "KONITYS" })).toEqual({ commercialId: 5 });
  });

  it("un compte client n'est jamais super admin, même avec un e-mail de ADMIN_EMAILS", () => {
    const u = { id: 1, email: "chef@selfizee.fr", nom: "", prenom: "", role: "ADMIN" as const, voitTousLieux: false, lieuIds: [] };
    expect(utilisateurSuperAdmin({ ...u, compte: "KONITYS" }, "chef@selfizee.fr")).toBe(true);
    expect(utilisateurSuperAdmin({ ...u, compte: "REGIE" }, "chef@selfizee.fr")).toBe(false);
  });
});

describe("accueil : connexion d'après l'e-mail", () => {
  it("client seulement avec un compte client actif, choix si l'adresse est aussi salariée", () => {
    expect(sorteConnexion({ clientsActifs: true, client: true, salarie: false })).toBe("client");
    expect(sorteConnexion({ clientsActifs: true, client: true, salarie: true })).toBe("choix");
    expect(sorteConnexion({ clientsActifs: true, client: false, salarie: false })).toBe("salarie");
    expect(sorteConnexion({ clientsActifs: false, client: true, salarie: false })).toBe("salarie");
  });
});
