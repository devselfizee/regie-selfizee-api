import { describe, expect, it } from "vitest";
import { estSuperAdmin } from "../src/lib/superAdmin.js";

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
