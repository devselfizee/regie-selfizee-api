import { describe, expect, it } from "vitest";
import { jourEtHeureLocaux, offsetMinutes } from "../src/lib/temps.js";
import { htDepuisTtc, pctVersBp } from "../src/lib/montants.js";
import { decouperCle, genererCle, verifierSecret } from "../src/lib/cleBorne.js";
import { adminsInitiaux } from "../src/middleware/utilisateur.js";
import { numeroInternational } from "../src/lib/envoi.js";

describe("temps", () => {
  it("lit le décalage d'un horodatage RFC 3339", () => {
    expect(offsetMinutes("2026-10-05T22:47:31+02:00")).toBe(120);
    expect(offsetMinutes("2026-10-05T22:47:31.120-03:30")).toBe(-210);
    expect(offsetMinutes("2026-10-05T20:47:31Z")).toBe(0);
  });

  it("calcule le jour et l'heure à Paris, y compris après minuit UTC", () => {
    // 23h30 UTC le 5 octobre = 1h30 le 6 octobre à Paris (heure d'été)
    const r = jourEtHeureLocaux(new Date("2026-10-05T23:30:00Z"));
    expect(r.jour.toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(r.heure).toBe(1);
  });

  it("gère l'heure d'hiver", () => {
    // 23h30 UTC le 15 décembre = 0h30 le 16 à Paris (UTC+1)
    const r = jourEtHeureLocaux(new Date("2026-12-15T23:30:00Z"));
    expect(r.jour.toISOString().slice(0, 10)).toBe("2026-12-16");
    expect(r.heure).toBe(0);
  });
});

describe("montants", () => {
  it("calcule le HT depuis le TTC", () => {
    expect(htDepuisTtc(800, 2000)).toBe(667); // 8,00 € TTC à 20 %
    expect(htDepuisTtc(1200, 2000)).toBe(1000);
    expect(htDepuisTtc(500, 0)).toBe(500);
  });
  it("convertit un pourcentage en points de base", () => {
    expect(pctVersBp(20)).toBe(2000);
    expect(pctVersBp(5.5)).toBe(550);
  });
});

describe("clé borne", () => {
  it("génère une clé vérifiable, et refuse une clé altérée", () => {
    const { cle, prefixe, hash } = genererCle();
    const parts = decouperCle(cle);
    expect(parts?.prefixe).toBe(prefixe);
    expect(verifierSecret(parts!.secret, hash)).toBe(true);
    expect(verifierSecret(parts!.secret.replace(/.$/, (c) => (c === "A" ? "B" : "A")), hash)).toBe(false);
  });
  it("refuse un format inconnu", () => {
    expect(decouperCle("Bearer n'importe quoi")).toBeNull();
  });
});

describe("ADMIN_EMAILS", () => {
  it("tolère les erreurs de saisie courantes", () => {
    expect(adminsInitiaux("s.mahe@konitys.fr")).toEqual(["s.mahe@konitys.fr"]);
    expect(adminsInitiaux('"S.Mahe@konitys.fr"')).toEqual(["s.mahe@konitys.fr"]);
    expect(adminsInitiaux("ADMIN_EMAILS=s.mahe@konitys.fr")).toEqual(["s.mahe@konitys.fr"]);
    expect(adminsInitiaux(" a@x.fr , b@x.fr;c@x.fr ")).toEqual(["a@x.fr", "b@x.fr", "c@x.fr"]);
    expect(adminsInitiaux("")).toEqual([]);
  });
});

describe("numéros de téléphone", () => {
  it("passe au format international attendu par SMSEnvoi", () => {
    expect(numeroInternational("06 12 34 56 78")).toBe("33612345678");
    expect(numeroInternational("+33 6 12 34 56 78")).toBe("33612345678");
    expect(numeroInternational("0033612345678")).toBe("33612345678");
  });
});
