import { describe, expect, it } from "vitest";
import { buildPermissionsSchema, CLES } from "../src/permissions/schema.js";

describe("schéma des droits Konitys", () => {
  const s = buildPermissionsSchema();

  it("a la forme attendue par l'Admin Panel", () => {
    expect(s.app).toBe("regie");
    expect(Array.isArray(s.groups)).toBe(true);
    expect(s.groups[0]).toMatchObject({ key: "access", permissions: [{ key: "app.access" }] });
    expect(s.groups[1].key).toBe("pages");
  });

  it("n'a que des clés en minuscules, séparées par des points, sans doublon", () => {
    const toutes = s.groups.flatMap((g) => g.permissions.map((p) => p.key));
    expect(new Set(toutes).size).toBe(toutes.length);
    for (const k of toutes) expect(k).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    for (const k of s.groups[1].permissions.map((p) => p.key)) expect(k).toMatch(/^pages\.[a-z0-9_]+\.view$/);
    expect(CLES.size).toBe(toutes.length);
  });
});
