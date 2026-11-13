import { describe, expect, it, vi } from "vitest";

// Historique : fusion des sources par date, curseur sans doublon ni ligne sautée quand des lignes ont la même date
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
const { fusionner } = await import("../src/routes/historique.js");
type L = Parameters<typeof fusionner>[0][number][number];

const ligne = (cle: string, minute: number): L => ({
  cle, type: "alerte", date: new Date(Date.UTC(2026, 10, 13, 10, minute)), titre: cle, detail: null, ton: "info", lieu: null, borne: null, utilisateur: null, evenement: null,
});

describe("fusion de l'historique", () => {
  it("les plus récentes d'abord, toutes sources mêlées ; pas de suite quand tout tient", () => {
    const r = fusionner([[ligne("a-1", 5), ligne("a-2", 1)], [ligne("b-1", 3)]], 10, new Set(), null);
    expect(r.lignes.map((l) => l.cle)).toEqual(["a-1", "b-1", "a-2"]);
    expect(r.suivant).toBeNull();
  });

  it("le curseur reprend à l'instant de la dernière ligne, en retirant celles déjà rendues à cet instant", () => {
    const sources = [[ligne("a-1", 9), ligne("a-2", 5), ligne("a-3", 5)], [ligne("b-1", 5), ligne("b-2", 2)]];
    const p1 = fusionner(sources, 2, new Set(), null);
    expect(p1.lignes.map((l) => l.cle)).toEqual(["a-1", "a-2"]);
    expect(p1.suivant).toBe("2026-11-13T10:05:00.000Z|a-2");
    // Page suivante : les sources rendent tout ce qui est à 10:05 ou avant ; a-2 est écartée
    const reste = sources.map((s) => s.filter((l) => l.date.getTime() <= Date.UTC(2026, 10, 13, 10, 5)));
    const p2 = fusionner(reste, 2, new Set(["a-2"]), Date.UTC(2026, 10, 13, 10, 5));
    expect(p2.lignes.map((l) => l.cle)).toEqual(["a-3", "b-1"]);
    // Même instant qu'avant : le curseur garde aussi les clés déjà écartées
    expect(p2.suivant).toBe("2026-11-13T10:05:00.000Z|a-3,b-1,a-2");
    const p3 = fusionner(reste, 2, new Set(["a-2", "a-3", "b-1"]), Date.UTC(2026, 10, 13, 10, 5));
    expect(p3.lignes.map((l) => l.cle)).toEqual(["b-2"]);
    expect(p3.suivant).toBeNull();
  });
});
