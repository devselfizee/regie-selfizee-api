import { DOSSIER_ILLUSTRATIONS } from "./illustrations.js";
import { readFileSync } from "node:fs";
import type { Composition, Gabarit, Reglages } from "./reglages.js";
import { ecrireJeton } from "../souvenir/jeton.js";
import { compositionAvecCadre, zoneDessinee, type CompositionKit } from "./composition.js";

// Génère le config.json chargé par la borne pour un lieu en régie (CDC page souvenir § 13.4).
// La partie commune (filtre, pages, langues, gabarits du kit) vient de l'export étalon FJT5 ;
// le reste vient des réglages de la fiche événement et des réglages fixés par le mode régie (§ 13.1).
// Un gabarit habillé au studio prend les zones photo de son cadre (composition.ts).

export interface Modele {
  customFilter: unknown;
  pages: unknown[];
  languages: unknown[];
  version: unknown;
  gabarits: Record<Gabarit, CompositionKit & { preview: string; overlay: string; lvOverlay?: string }>;
}

let modele: Modele | null = null;
export const lireModele = (): Modele =>
  (modele ??= JSON.parse(readFileSync(new URL("../../modeles/evenement-nightlife.json", import.meta.url), "utf8")) as Modele);

/**
 * Base du lien imprimé en QR (#TOKEN# = code d'événement, tiret, photo_uuid de la séance), d'après SOUVENIR_QR_BASE_URL.
 * Une adresse donnée sans #TOKEN# (« https://souvenir.exemple.com/ ») est complétée par le chemin de la page, /p/#TOKEN#.
 */
export function baseQr(valeur: string | undefined): string {
  const v = valeur?.trim();
  if (!v) return "https://myevent.selfizee.fr/p/#TOKEN#";
  return v.includes("#TOKEN#") ? v : `${v.replace(/\/+$/, "")}/p/#TOKEN#`;
}
export const QR_BASE_URL = baseQr(process.env.SOUVENIR_QR_BASE_URL);

/** Lien de la page souvenir d'une séance : la base du QR avec le jeton `CODE-photo_uuid`. */
export const lienPageSouvenir = (code: string, photoUuid: string) => QR_BASE_URL.replace("#TOKEN#", ecrireJeton(code, photoUuid));

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
  /** Cadres dessinés au studio (JSON Fabric), un au plus par composition. */
  cadres?: { compositionId: string; canvas: string; formatId?: string | null }[];
  /** Nom d'un événement ponctuel (« Halloween ») : ajouté au nom affiché par la borne */
  nomEvenement?: string | null;
}

export type GabaritKit = Modele["gabarits"][Gabarit];

/** Un fichier du kit pour la n-ième composition du même gabarit : strip_frame.png, strip_frame_1.png… */
const numeroter = (chemin: string, n: number) => (n === 0 || !chemin ? chemin : chemin.replace(/(\.\w+)$/, `_${n}$1`));

/**
 * Les compositions de l'événement, dans l'ordre de l'écran de choix, chacune avec la composition du kit
 * de son gabarit et ses noms de fichiers (numérotés quand un même gabarit revient : 8 polas…).
 * `kit` garde les noms du kit, à lire dans modeles/evenement-nightlife/.
 */
export function compositionsDeLEvenement(r: Reglages, m: Modele = lireModele()): { composition: Composition; kit: GabaritKit; fichiers: GabaritKit }[] {
  const vus = new Map<Gabarit, number>();
  return r.gabarits.choisis.map((composition) => {
    const kit = m.gabarits[composition.gabarit];
    const n = vus.get(composition.gabarit) ?? 0;
    vus.set(composition.gabarit, n + 1);
    const fichiers = { ...kit, overlay: numeroter(kit.overlay, n), preview: numeroter(kit.preview, n), ...(kit.lvOverlay ? { lvOverlay: numeroter(kit.lvOverlay, n) } : {}) };
    return { composition, kit, fichiers };
  });
}

const euros = (cents: number) => Math.round(cents) / 100;
/** Nom du gabarit tel que la borne le renvoie dans ses parcours (cadre) : Frames/polaroid_preview_2.jpg → polaroid_preview_2 */
export const nomPreview = (preview: string) => preview.replace(/^Frames\//, "").replace(/\.jpg$/, "");

/** « 2026-10-23 14:05:09 », heure de Paris, comme updateDate des exports booth. */
export function horodatageParis(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function genererConfig({ code, motDePasseTableau, reglages: r, horaires, maintenant, cadres = [], nomEvenement }: EntreeGeneration) {
  const m = lireModele();
  const compositions = compositionsDeLEvenement(r, m);
  const t = r.tarifs;
  const paliers = [...t.paliers].sort((a, b) => a.de - b.de);
  const l = r.lieu;

  return {
    event: {
      code,
      customerDashboardPassword: motDePasseTableau,
      endDate: l.dateFin,
      name: (nomEvenement ? `${l.nom} · ${nomEvenement}` : l.nom).toUpperCase(),
      startDate: l.dateDebut,
      allowRetry: true,
      updateDate: horodatageParis(maintenant),
    },
    customFilter: m.customFilter,
    userSettings: {
      // Fixés par le mode régie (CDC § 13.1), sans question à l'exploitant
      uiKit: r.theme,
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
      // Illustrations (mémo du 05/11) : les photos de l'événement sont dans le zip (dossier lu en premier),
      // la série du logiciel sert de repli ; « none » = la caméra en direct ; cases unies sans illustration
      illustrationSet: l.illustrations === "chic" ? "chic" : l.illustrations === "camera" ? "none" : "festif",
      ...(l.illustrations === "aucune" ? { previewFillHoles: false } : {}),
      ...(l.illustrationsAccueil === "photos" || l.illustrationsAccueil === "serie" || l.illustrationsAccueil === "client"
        ? { welcomeIllustrationSet: DOSSIER_ILLUSTRATIONS.accueil }
        : l.illustrationsAccueil === "festif" || l.illustrationsAccueil === "chic"
          ? { welcomeIllustrationSet: l.illustrationsAccueil }
          : {}),
      assistanceOwner: l.assistance.proprietaire,
      ...(l.assistance.telephone ? { assistancePhone: l.assistance.telephone } : {}),
      ...(l.assistance.email ? { assistanceEmail: l.assistance.email } : {}),
      openingHours: [...horaires]
        .sort((a, b) => a.jourSemaine - b.jourSemaine || a.ouverture.localeCompare(b.ouverture))
        .map((h) => ({ day: h.jourSemaine, open: h.ouverture, close: h.fermeture })),
      // Les gabarits (écran 2)
      welcomeFormats: r.gabarits.accueil.flatMap((id) => {
        const c = compositions.find((x) => x.composition.id === id);
        return c ? [nomPreview(c.fichiers.preview)] : [];
      }),
      sharePageQR: { qrBaseUrl: QR_BASE_URL },
    },
    compositions: compositions.map(({ composition, fichiers }) => {
      const cadre = cadres.find((c) => c.compositionId === composition.id);
      return cadre ? compositionAvecCadre(fichiers, cadre.canvas, zoneDessinee(fichiers, cadre.formatId)) : fichiers;
    }),
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
