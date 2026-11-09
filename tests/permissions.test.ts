import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { canForApp, droitPerimetre, estAdminPlateforme, isEnforced, peutVoirTout, userCan, type DroitsMoi } from "../src/middleware/permissions.js";

const actif = { globally_enabled: true };
const moi = (droits: Record<string, boolean>, extra: Partial<DroitsMoi> = {}): DroitsMoi => ({ apps: { regie: droits }, enforcement: actif, ...extra });

describe("réglage « contrôle d'accès »", () => {
  it("global, sauf les apps en mode dev ; sinon app par app", () => {
    expect(isEnforced({ globally_enabled: true }, "regie")).toBe(true);
    expect(isEnforced({ globally_enabled: true, disable_specific: true, disabled_apps: ["regie"] }, "regie")).toBe(false);
    expect(isEnforced({ globally_enabled: false, enable_specific: true, enabled_apps: ["regie"] }, "regie")).toBe(true);
    expect(isEnforced({ globally_enabled: false, enable_specific: true, enabled_apps: ["bornes"] }, "regie")).toBe(false);
    expect(isEnforced(undefined, "regie")).toBe(false);
  });
});

describe("canForApp", () => {
  it("fail-open sans réponse du gateway, admin partout, contrôle désactivé = tout autorisé", () => {
    expect(canForApp(null, "regie", "lieux.edit")).toBe(true);
    expect(canForApp(moi({}, { is_admin: true }), "regie", "lieux.edit")).toBe(true);
    expect(canForApp(moi({}, { enforcement: {} }), "regie", "lieux.edit")).toBe(true);
  });
  it("contrôle actif : seulement les droits cochés", () => {
    expect(canForApp(moi({ "lieux.edit": true }), "regie", "lieux.edit")).toBe(true);
    expect(canForApp(moi({ "lieux.edit": false }), "regie", "lieux.edit")).toBe(false);
    expect(canForApp(moi({}), "regie", "lieux.edit")).toBe(false);
  });
});

describe("périmètre en mode fermé (peutVoirTout)", () => {
  it("jamais de fail-open : sans gateway, ou contrôle désactivé sans le droit, on ne voit que les siens", () => {
    expect(droitPerimetre(null, "lieux.view_any")).toBe(false);
    expect(droitPerimetre(moi({}, { enforcement: {} }), "lieux.view_any")).toBe(false);
    expect(droitPerimetre(moi({ "lieux.view_any": true }), "lieux.view_any")).toBe(true);
    expect(droitPerimetre(moi({}, { is_admin: true }), "lieux.view_any")).toBe(true);
  });
});

describe("droits simulés sans Keycloak (X-Dev-Droits, tests avec base)", () => {
  const req = (droits?: string) => ({ header: (n: string) => (n.toLowerCase() === "x-dev-droits" ? droits : undefined), headers: {} }) as unknown as Request;

  it("sans l'en-tête, tout est autorisé et l'utilisateur voit tout", async () => {
    expect(await userCan(req(), "paiements.view")).toBe(true);
    expect(await peutVoirTout(req(), "lieux.view_any")).toBe(true);
  });

  it("avec l'en-tête, seules les clés données passent (contrôle actif), « * » = admin", async () => {
    const commercial = req("app.access,lieux.view_own,ventes.view");
    expect(await userCan(commercial, "ventes.view")).toBe(true);
    expect(await userCan(commercial, "paiements.view")).toBe(false);
    expect(await peutVoirTout(commercial, "lieux.view_any")).toBe(false);
    expect(await estAdminPlateforme(commercial)).toBe(false);
    expect(await userCan(req("*"), "paiements.view")).toBe(true);
    expect(await peutVoirTout(req("*"), "lieux.view_any")).toBe(true);
  });
});
