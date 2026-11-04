import { describe, expect, it } from "vitest";
import { categorieGoogle, devinerCategorie } from "../src/concurrents/categorie.js";

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

describe("catégorie d'après les types Google Places", () => {
  it("le type principal d'abord", () => expect(categorieGoogle("bar", ["night_club", "bar"])).toBe("BAR"));
  it("puis les autres types", () => expect(categorieGoogle(null, ["point_of_interest", "night_club"])).toBe("BOITE_DE_NUIT"));
  it("tous les restaurants", () => expect(categorieGoogle("italian_restaurant", [])).toBe("RESTAURANT"));
  it("centre commercial", () => expect(categorieGoogle("shopping_mall", [])).toBe("CENTRE_COMMERCIAL"));
  it("rien d'utile", () => expect(categorieGoogle("point_of_interest", ["establishment"])).toBeNull());
});
