import { describe, expect, it } from "vitest";
import type { EvenementMarketing } from "@prisma/client";
import { occurrences } from "../src/calendrier/marketing.js";

const ev = (id: number, nom: string, debut: string, fin: string, annuel: boolean): EvenementMarketing => ({
  id, nom, debut: new Date(`${debut}T00:00:00Z`), fin: new Date(`${fin}T00:00:00Z`), annuel, createdAt: new Date(),
});
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("calendrier marketing", () => {
  it("répète un événement annuel chaque année de la période", () => {
    const o = occurrences([ev(1, "Halloween", "2026-10-31", "2026-10-31", true)], d("2025-01-01"), d("2027-12-31"));
    expect(o.map((x) => x.du)).toEqual(["2025-10-31", "2026-10-31", "2027-10-31"]);
  });

  it("garde une période qui touche la plage, même commencée avant", () => {
    const o = occurrences([ev(2, "Coupe du monde", "2026-06-11", "2026-07-19", false)], d("2026-07-01"), d("2026-07-31"));
    expect(o).toEqual([{ id: 2, nom: "Coupe du monde", du: "2026-06-11", au: "2026-07-19", annuel: false }]);
  });

  it("ignore ce qui tombe hors de la plage", () => {
    expect(occurrences([ev(3, "Fête des mères", "2026-05-31", "2026-05-31", false)], d("2026-10-01"), d("2026-10-31"))).toEqual([]);
  });
});
