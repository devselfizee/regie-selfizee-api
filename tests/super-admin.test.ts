import { describe, expect, it } from "vitest";
import { estSuperAdmin, exigerSuperAdmin } from "../src/lib/superAdmin.js";

describe("estSuperAdmin", () => {
  it("reconnaît un e-mail de la liste, sans tenir compte de la casse ni des espaces", () => {
    expect(estSuperAdmin("Un@Exemple.fr", " un@exemple.fr , deux@exemple.fr")).toBe(true);
    expect(estSuperAdmin("deux@exemple.fr", "un@exemple.fr,deux@exemple.fr")).toBe(true);
  });

  it("refuse un e-mail absent de la liste", () => {
    expect(estSuperAdmin("trois@exemple.fr", "un@exemple.fr,deux@exemple.fr")).toBe(false);
  });

  it("refuse tout le monde sans liste ou sans e-mail", () => {
    expect(estSuperAdmin("un@exemple.fr", "")).toBe(false);
    expect(estSuperAdmin("un@exemple.fr", undefined)).toBe(false);
    expect(estSuperAdmin("", "un@exemple.fr")).toBe(false);
    expect(estSuperAdmin(null, ",,")).toBe(false);
  });
});

describe("exigerSuperAdmin", () => {
  const appeler = (email: string | undefined) => {
    let resultat: unknown = "rien";
    exigerSuperAdmin({ utilisateur: email ? { email } : undefined } as never, {} as never, (e?: unknown) => (resultat = e));
    return resultat;
  };

  it("laisse passer un e-mail de ADMIN_EMAILS, refuse les autres en 403", () => {
    const avant = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "un@exemple.fr";
    try {
      expect(appeler("un@exemple.fr")).toBeUndefined();
      expect(appeler("deux@exemple.fr")).toMatchObject({ status: 403, code: "SUPER_ADMIN_REQUIS" });
      expect(appeler(undefined)).toMatchObject({ status: 403 });
    } finally {
      if (avant === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = avant;
    }
  });
});
