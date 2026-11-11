import { randomInt } from "node:crypto";
import { z } from "zod";
import { erreursGrille, GRILLE_DEFAUT, grilleSchema, type Grille } from "../tarifs/grille.js";

// Réglages de l'événement d'un lieu (CDC page souvenir § 13) : ce que l'exploitant saisit
// dans la fiche événement. Montants en centimes ; le config.json de la borne les veut en euros.

export const GABARITS = ["bandelette", "pola", "planche", "carte", "paysage", "bandelette-couchee"] as const;
export type Gabarit = (typeof GABARITS)[number];

// Thème de l'interface de la borne (userSettings.uiKit) : « halloween » et les thèmes personnalisés
// viendront quand la borne saura les afficher
export const THEMES = ["nightlife"] as const;

/** Compositions sur l'écran de choix de la borne, au plus (pages.chooseFormat.maximumStaticDisplayCount). */
export const MAX_COMPOSITIONS = 9;

export const TONS = ["club", "bar", "famille", "pro"] as const;
// Photos d'exemple dans les cases des cadres (page de choix, cadres de l'accueil) : séries du logiciel
// (festif, chic), photos de l'événement (zip), caméra en direct, ou cases unies. L'accueil peut avoir sa
// propre série (« memes » : celle des cadres). Mémo ILLUSTRATIONS-ADMIN-WEB du 05/11/2026.
// « serie » : une série de la bibliothèque (illustrationsSerieId), copiée dans le zip comme les photos.
export const ILLUSTRATIONS = ["festif", "chic", "serie", "photos", "camera", "aucune"] as const;
export const ILLUSTRATIONS_ACCUEIL = ["memes", "festif", "chic", "serie", "photos"] as const;
export const LOTS = ["free", "pct50", "pct30", "none"] as const;

const texte = z.string().trim().max(200);
const facultatif = (s: z.ZodType<string>) => s.nullable().optional().transform((v) => (v ? v : null));
const jour = z.iso.date();
/** Heure « HH:mm » (début et fin d'un événement programmé), maquettes du 10/11/2026 */
export const heureSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Heure attendue au format HH:mm");

/** Début et fin d'un événement en « AAAA-MM-JJTHH:mm » : sans heure, du début du premier jour à la fin du dernier. */
export const instantsDe = (l: { dateDebut: string; dateFin: string; heureDebut?: string | null; heureFin?: string | null }) => ({
  debut: `${l.dateDebut}T${l.heureDebut ?? "00:00"}`,
  fin: `${l.dateFin}T${l.heureFin ?? "24:00"}`,
});

// Une composition de l'écran de choix : un gabarit du kit, avec son cadre au studio s'il y en a un.
// Un même gabarit peut revenir plusieurs fois (8 polas, 2 bandelettes…), chacun son id.
const compositionSchema = z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), gabarit: z.enum(GABARITS) });
export type Composition = z.infer<typeof compositionSchema>;
// Fiches enregistrées avant : un gabarit par nom ; sa composition garde le nom du gabarit pour id
const versCompositions = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? { id: x, gabarit: x } : x)) : v);

export const reglagesSchema = z
  .object({
    theme: z.enum(THEMES).default("nightlife"),
    lieu: z.object({
      nom: texte.min(1),
      ville: facultatif(texte),
      dateDebut: jour,
      dateFin: jour,
      // Heures de début et de fin (null : toute la journée), ajoutées le 11/11/2026
      heureDebut: heureSchema.nullable().default(null),
      heureFin: heureSchema.nullable().default(null),
      ton: z.enum(TONS).default("club"),
      illustrations: z.enum(ILLUSTRATIONS).default("festif"),
      illustrationsAccueil: z.enum(ILLUSTRATIONS_ACCUEIL).default("memes"),
      illustrationsSerieId: z.number().int().positive().nullable().default(null),
      illustrationsAccueilSerieId: z.number().int().positive().nullable().default(null),
      avisGoogleUrl: facultatif(z.url({ protocol: /^https?$/ }).max(500)),
      instagram: facultatif(texte),
      tiktok: facultatif(texte),
      hashtag: facultatif(texte),
      assistance: z.object({
        proprietaire: z.enum(["selfizee", "client"]).default("selfizee"),
        telephone: facultatif(texte),
        email: facultatif(z.email()),
      }),
    }),
    gabarits: z.object({
      // Dans l'ordre de l'écran de choix de la borne
      choisis: z.preprocess(versCompositions, z.array(compositionSchema).max(MAX_COMPOSITIONS)),
      // Compositions mises en avant sur l'écran d'accueil (welcomeFormats), par id
      accueil: z.array(z.string()).max(MAX_COMPOSITIONS),
    }),
    tarifs: z.object({
      // Reprendre les tarifs du lieu (ses tarifs propres, sinon ceux de base du parc) : la grille
      // ci-dessous est alors remplacée à la lecture. Faux pour les fiches enregistrées avant.
      herite: z.boolean().default(false),
      ...grilleSchema.shape,
      codesPromo: z.boolean(),
      jeu: z.object({
        actif: z.boolean(),
        lots: z.object({ free: z.number().int().min(0), pct50: z.number().int().min(0), pct30: z.number().int().min(0), none: z.number().int().min(0) }),
        maxLotsParJour: z.number().int().min(0).max(10_000),
      }),
      reimpressionWeb: z.boolean(),
      photoAppel: z.object({ actif: z.boolean(), inactiviteSec: z.number().int().min(10).max(3600) }),
      envoiPostal: z.object({ actif: z.boolean(), fraisCents: z.number().int().min(0).max(100_00) }),
    }),
  })
  .strict();

export type Reglages = z.infer<typeof reglagesSchema>;

// Infos du lieu pour la borne : renseignées une fois sur le lieu (Configuration → Infos du lieu) et
// reprises par chacun de ses événements, qui ne gardent que leurs dates, leur ton et leurs illustrations.
export const infosLieuSchema = reglagesSchema.shape.lieu.pick({
  nom: true,
  ville: true,
  avisGoogleUrl: true,
  instagram: true,
  tiktok: true,
  hashtag: true,
  assistance: true,
});
export type InfosLieu = z.infer<typeof infosLieuSchema>;

/**
 * Les infos du lieu : celles enregistrées sur le lieu ; à défaut, celles de son événement par défaut
 * (configuré avant qu'elles passent sur le lieu) ; à défaut, la fiche du lieu.
 */
export function infosDuLieu(
  enregistrees: unknown,
  lieu: { enseigne: string; ville: string | null },
  reglagesHabituel?: unknown,
): InfosLieu {
  const lues = infosLieuSchema.safeParse(enregistrees);
  if (lues.success) return lues.data;
  const habituel = reglagesSchema.safeParse(reglagesHabituel);
  if (habituel.success) return infosLieuSchema.parse(habituel.data.lieu);
  const d = reglagesParDefaut({ ...lieu, dateInstallation: null }).lieu;
  return infosLieuSchema.parse(d);
}

/** Réglages d'un événement avec les infos de son lieu (ce que la borne recevra). */
export const avecInfosDuLieu = (r: Reglages, infos: InfosLieu): Reglages => ({ ...r, lieu: { ...r.lieu, ...infos } });

/** Réglages par défaut du mode régie (CDC § 13.3), habillés avec la fiche du lieu. */
export function reglagesParDefaut(lieu: { enseigne: string; ville: string | null; dateInstallation: Date | null }, aujourdhui = new Date()): Reglages {
  const debut = lieu.dateInstallation ?? aujourdhui;
  const fin = new Date(debut);
  fin.setUTCFullYear(fin.getUTCFullYear() + 2);
  return {
    theme: "nightlife",
    lieu: {
      nom: lieu.enseigne,
      ville: lieu.ville,
      dateDebut: debut.toISOString().slice(0, 10),
      dateFin: fin.toISOString().slice(0, 10),
      heureDebut: null,
      heureFin: null,
      ton: "club",
      illustrations: "festif",
      illustrationsAccueil: "memes",
      illustrationsSerieId: null,
      illustrationsAccueilSerieId: null,
      avisGoogleUrl: null,
      instagram: null,
      tiktok: null,
      hashtag: null,
      assistance: { proprietaire: "selfizee", telephone: null, email: null },
    },
    // Aucun format au départ (demande de Paul, 05/11/2026) : on n'ajoute que ceux qu'on personnalise
    gabarits: { choisis: [], accueil: [] },
    tarifs: {
      herite: true,
      ...GRILLE_DEFAUT,
      codesPromo: true,
      jeu: { actif: true, lots: { free: 5, pct50: 10, pct30: 35, none: 50 }, maxLotsParJour: 50 },
      // Faux tant que l'API des crédits de réimpression n'est pas en production (CDC § 13.3)
      reimpressionWeb: false,
      photoAppel: { actif: false, inactiviteSec: 60 },
      envoiPostal: { actif: false, fraisCents: 200 },
    },
  };
}

export interface Controle {
  niveau: "erreur" | "avertissement";
  message: string;
}

const AVEC_QR: Gabarit[] = ["bandelette", "carte", "bandelette-couchee"];

/** Contrôles avant publication (CDC § 13.4) : une erreur bloque, un avertissement non. */
export function controler(r: Reglages, aDesHoraires: boolean): Controle[] {
  const c: Controle[] = [];
  const erreur = (message: string) => c.push({ niveau: "erreur", message });
  const avertir = (message: string) => c.push({ niveau: "avertissement", message });

  const { debut, fin } = instantsDe(r.lieu);
  if (fin <= debut) erreur("La fin est avant le début.");

  const choisis = r.gabarits.choisis;
  const ids = choisis.map((c) => c.id);
  if (!choisis.length) erreur("Choisissez au moins un gabarit.");
  if (choisis.length > MAX_COMPOSITIONS) erreur(`L'écran de choix de la borne affiche ${MAX_COMPOSITIONS} formats au plus.`);
  if (new Set(ids).size !== ids.length) erreur("Deux compositions ont le même identifiant.");
  if (r.gabarits.accueil.some((id) => !ids.includes(id))) erreur("Un format mis en avant à l'accueil n'est pas dans les gabarits choisis.");
  if (choisis.length && !choisis.some((c) => AVEC_QR.includes(c.gabarit)))
    avertir("Aucun gabarit avec carte et QR : pas de carte, pas de collecte d'e-mails sur la page souvenir.");
  if (choisis.some((c) => c.gabarit === "carte")) avertir("La photo + deux cartes demande un ruban 15x20 dans l'imprimante (DS620).");

  if (r.lieu.illustrations === "serie" && !r.lieu.illustrationsSerieId) erreur("Photos d'exemple des cadres : choisissez une série de la bibliothèque.");
  if (r.lieu.illustrationsAccueil === "serie" && !r.lieu.illustrationsAccueilSerieId) erreur("Photos d'exemple de l'accueil : choisissez une série de la bibliothèque.");

  for (const m of erreursGrille(r.tarifs)) erreur(m);

  const lots = r.tarifs.jeu.lots;
  if (r.tarifs.jeu.actif) {
    if (!r.tarifs.codesPromo) erreur("Le jeu est actif : les codes promo doivent être acceptés à la borne, sinon les codes gagnés ne servent à rien.");
    if (lots.free + lots.pct50 + lots.pct30 + lots.none === 0) erreur("Le jeu est actif mais tous les lots ont un poids de 0.");
  }
  if (r.tarifs.reimpressionWeb) avertir("Réimpression payée depuis le mobile : à n'activer qu'une fois l'API des crédits en production.");
  if (!r.lieu.avisGoogleUrl) avertir("Pas de lien d'avis Google : le bloc « avis » sera absent du mail de livraison.");
  if (!aDesHoraires) avertir("Pas d'horaires d'ouverture sur la fiche du lieu : la borne ne passera pas en veille hors horaires.");
  return [...new Map(c.map((x) => [x.message, x])).values()];
}

// Code d'événement régie : R + trois caractères sans I, L, O, 0, 1 (CDC § 14.1)
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function genererCodeEvenement(tirer: (n: number) => number = randomInt): string {
  let code = "R";
  for (let i = 0; i < 3; i++) code += ALPHABET[tirer(ALPHABET.length)];
  return code;
}

/** Mot de passe du tableau de bord client de la borne (customerDashboardPassword). */
export function genererMotDePasse(tirer: (n: number) => number = randomInt): string {
  let mdp = "";
  for (let i = 0; i < 8; i++) mdp += ALPHABET[tirer(ALPHABET.length)];
  return mdp;
}

/** Réglages tels que la borne les recevra : la grille du lieu remplace celle de l'événement s'il en hérite. */
export function avecGrilleDuLieu(r: Reglages, grilleLieu: Grille): Reglages {
  if (!r.tarifs.herite) return r;
  const { paliers, palierMisEnAvant, libelleMisEnAvant, plusUnCents } = grilleLieu;
  return { ...r, tarifs: { ...r.tarifs, paliers, palierMisEnAvant, libelleMisEnAvant, plusUnCents } };
}
