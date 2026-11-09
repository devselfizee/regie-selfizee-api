import { describe, expect, it } from "vitest";
import { canForApp, droitPerimetre, isEnforced, type DroitsMoi } from "../src/middleware/permissions.js";

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
