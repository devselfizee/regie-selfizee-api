import { describe, expect, it } from "vitest";
import { devinerCategorie } from "../src/concurrents/categorie.js";

describe("catégorie devinée d'un emplacement de concurrent", () => {
  it.each([
    ["O'SULLIVANS BASTILLE", "BAR"],
    ["Levrette Café - Nantes", "BAR"],
    ["Espit Chupitos Lyon", "BAR"],
    ["Coco Club - Toulouse (Balma)", "BOITE_DE_NUIT"],
    ["Forum des Halles", "CENTRE_COMMERCIAL"],
    ["Westfield_Parly 2", "CENTRE_COMMERCIAL"],
    ["Les Halles de Bacalan / Biltoki - Bordeaux", "FOOD_COURT"],
    ["CGR Blagnac", "CINEMA"],
    ["Le Zénith", "SALLE_SPECTACLE"],
    ["Musée Grévin", "LIEU_TOURISTIQUE"],
    ["Doppio Malto - La Défense", "RESTAURANT"],
  ])("%s → %s", (nom, code) => expect(devinerCategorie(nom)).toBe(code));

  it("rien quand le nom ne dit rien", () => expect(devinerCategorie("Odette")).toBeNull());
});
