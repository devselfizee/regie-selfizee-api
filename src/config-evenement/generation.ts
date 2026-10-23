import { readFileSync } from "node:fs";
import type { Gabarit, Reglages } from "./reglages.js";

// Génère le config.json chargé par la borne pour un lieu en régie (CDC page souvenir § 13.4).
// La partie commune (filtre, pages, langues, gabarits du kit) vient de l'export étalon FJT5 ;
// le reste vient des réglages de la fiche événement et des réglages fixés par le mode régie (§ 13.1).

interface Modele {
  customFilter: unknown;
  pages: unknown[];
  languages: unknown[];
  version: unknown;
  gabarits: Record<Gabarit, { preview: string } & Record<string, unknown>>;
}

let modele: Modele | null = null;
const lireModele = (): Modele =>
  (modele ??= JSON.parse(readFileSync(new URL("../../modeles/evenement-nightlife.json", import.meta.url), "utf8")) as Modele);

/** Base du lien imprimé en QR (#TOKEN# = code d'événement + photo_uuid de la séance). */
export const QR_BASE_URL = process.env.SOUVENIR_QR_BASE_URL || "https://myevent.selfizee.fr/p/#TOKEN#";

export interface HoraireOuverture {
  jourSemaine: number; // 1 = lundi … 7 = dimanche
  ouverture: string; // "18:00"
  fermeture: string; // "02:00" (après minuit = le lendemain)
}

export interface EntreeGeneration {
  code: string;
  motDePasseTableau: string;
  reglages: Reglages;
  horaires: HoraireOuverture[];
  maintenant: Date;
}

const euros = (cents: number) => Math.round(cents) / 100;
const nomPreview = (g: Gabarit, m: Modele) => m.gabarits[g].preview.replace(/^Frames\//, "").replace(/\.jpg$/, "");

/** « 2026-10-23 14:05:09 », heure de Paris, comme updateDate des exports booth. */
function horodatageParis(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function genererConfig({ code, motDePasseTableau, reglages: r, horaires, maintenant }: EntreeGeneration) {
  const m = lireModele();
  const t = r.tarifs;
  const paliers = [...t.paliers].sort((a, b) => a.de - b.de);
  const l = r.lieu;

  return {
    event: {
      code,
      customerDashboardPassword: motDePasseTableau,
      endDate: l.dateFin,
      name: l.nom.toUpperCase(),
      startDate: l.dateDebut,
      allowRetry: true,
      updateDate: horodatageParis(maintenant),
    },
    customFilter: m.customFilter,
    userSettings: {
      // Fixés par le mode régie (CDC § 13.1), sans question à l'exploitant
      uiKit: "nightlife",
      welcomeShowPrice: false,
      reprintEnabled: true,
      mirrorView: true,
      sendOriginals: false,
      firstShootCountDown: 3,
      otherShootsCountDown: 2,
      singleShootCountDown: 4,
      watchdogTimeoutDelay: 80,
      watchdogNotificationDelay: 10,
      enableColorFilter: true,
      enableBlackAndWhiteFilter: false,
      enableSepiaFilter: false,
      enableCustomFilter: false,
      enableForm: false,
      enableGreenScreen: false,
      greenScreenAutoSet: true,
      enableRemoveBG: false,
      removeBgToken: "",
      shutterSound: true,
      countdownSound: false,
      allowPrinting: true,
      allowMultiPrinting: true,
      multiPrintingLimit: 20,
      showRemainingSheets: true,
      printerAutoDetect: true,
      enablePrintTpeCb: false,
      // Paiement : terminal Hexapay
      enablePayment: true,
      payMode: "hexapay",
      hexaDir: "C:/Hexapay/",
      // Tarifs (écran 3)
      printPrice: euros(paliers[0].prixCents),
      pricing: {
        enabled: paliers.length > 1,
        method: "progressive",
        ...(t.palierMisEnAvant !== null
          ? // « hightlightlabel » : orthographe de l'export booth ; « highlightLabel » : celle de la note nightlife
            { highlight: t.palierMisEnAvant, hightlightlabel: t.libelleMisEnAvant, highlightLabel: t.libelleMisEnAvant }
          : {}),
        tiers: paliers.map((p) => ({ from: p.de, unitPrice: euros(p.prixCents) })),
      },
      upsellExtraPrintPrice: euros(t.plusUnCents),
      allowPromoCode: t.codesPromo,
      webReprint: t.reimpressionWeb,
      attractShoot: t.photoAppel.actif,
      attractShootIdleSec: t.photoAppel.inactiviteSec,
      postalDelivery: t.envoiPostal.actif,
      postalFee: euros(t.envoiPostal.fraisCents),
      // Le lieu (écran 1)
      phrasesTone: l.ton,
      illustrationSet: l.illustrations,
      assistanceOwner: l.assistance.proprietaire,
      ...(l.assistance.telephone ? { assistancePhone: l.assistance.telephone } : {}),
      ...(l.assistance.email ? { assistanceEmail: l.assistance.email } : {}),
      openingHours: [...horaires]
        .sort((a, b) => a.jourSemaine - b.jourSemaine || a.ouverture.localeCompare(b.ouverture))
        .map((h) => ({ day: h.jourSemaine, open: h.ouverture, close: h.fermeture })),
      // Les gabarits (écran 2)
      welcomeFormats: r.gabarits.accueil.map((g) => nomPreview(g, m)),
      sharePageQR: { qrBaseUrl: QR_BASE_URL },
    },
    compositions: r.gabarits.choisis.map((g) => m.gabarits[g]),
    pages: m.pages,
    languages: m.languages,
    version: m.version,
    // Lus par la page souvenir, ignorés par la borne (CDC § 10)
    web: {
      venueName: l.nom,
      city: l.ville,
      googleReviewUrl: l.avisGoogleUrl,
      instagram: l.instagram,
      tiktok: l.tiktok,
      hashtag: l.hashtag ?? "@selfizee",
    },
    game: {
      enabled: t.jeu.actif,
      prizes: (Object.entries(t.jeu.lots) as [string, number][]).map(([kind, weight]) => ({ kind, weight })),
      maxPrizesPerDay: t.jeu.maxLotsParJour,
    },
  };
}
