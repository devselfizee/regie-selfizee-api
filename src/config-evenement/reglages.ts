import { randomInt } from "node:crypto";
import { z } from "zod";
import { erreursGrille, GRILLE_DEFAUT, grilleSchema, type Grille } from "../tarifs/grille.js";

// Réglages de l'événement d'un lieu (CDC page souvenir § 13) : ce que l'exploitant saisit
// dans la fiche événement. Montants en centimes ; le config.json de la borne les veut en euros.

export const GABARITS = ["bandelette", "pola", "planche", "carte"] as const;
export type Gabarit = (typeof GABARITS)[number];

export const TONS = ["club", "bar", "famille", "pro"] as const;
export const ILLUSTRATIONS = ["festif", "chic"] as const;
export const LOTS = ["free", "pct50", "pct30", "none"] as const;

const texte = z.string().trim().max(200);
const facultatif = (s: z.ZodType<string>) => s.nullable().optional().transform((v) => (v ? v : null));
const jour = z.iso.date();

export const reglagesSchema = z
  .object({
    lieu: z.object({
      nom: texte.min(1),
      ville: facultatif(texte),
      dateDebut: jour,
      dateFin: jour,
      ton: z.enum(TONS).default("club"),
      illustrations: z.enum(ILLUSTRATIONS).default("festif"),
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
      choisis: z.array(z.enum(GABARITS)).max(GABARITS.length),
      // Formats mis en avant sur l'écran d'accueil (welcomeFormats)
      accueil: z.array(z.enum(GABARITS)).max(GABARITS.length),
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

/** Réglages par défaut du mode régie (CDC § 13.3), habillés avec la fiche du lieu. */
export function reglagesParDefaut(lieu: { enseigne: string; ville: string | null; dateInstallation: Date | null }, aujourdhui = new Date()): Reglages {
  const debut = lieu.dateInstallation ?? aujourdhui;
  const fin = new Date(debut);
  fin.setUTCFullYear(fin.getUTCFullYear() + 2);
  return {
    lieu: {
      nom: lieu.enseigne,
      ville: lieu.ville,
      dateDebut: debut.toISOString().slice(0, 10),
      dateFin: fin.toISOString().slice(0, 10),
      ton: "club",
      illustrations: "festif",
      avisGoogleUrl: null,
      instagram: null,
      tiktok: null,
      hashtag: null,
      assistance: { proprietaire: "selfizee", telephone: null, email: null },
    },
    gabarits: { choisis: ["bandelette", "pola"], accueil: ["bandelette", "pola"] },
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

const AVEC_QR: Gabarit[] = ["bandelette", "carte"];

/** Contrôles avant publication (CDC § 13.4) : une erreur bloque, un avertissement non. */
export function controler(r: Reglages, aDesHoraires: boolean): Controle[] {
  const c: Controle[] = [];
  const erreur = (message: string) => c.push({ niveau: "erreur", message });
  const avertir = (message: string) => c.push({ niveau: "avertissement", message });

  if (r.lieu.dateFin < r.lieu.dateDebut) erreur("La date de fin est avant la date de début.");

  if (!r.gabarits.choisis.length) erreur("Choisissez au moins un gabarit.");
  if (new Set(r.gabarits.choisis).size !== r.gabarits.choisis.length) erreur("Un gabarit est choisi deux fois.");
  if (r.gabarits.accueil.some((g) => !r.gabarits.choisis.includes(g))) erreur("Un format mis en avant à l'accueil n'est pas dans les gabarits choisis.");
  if (r.gabarits.choisis.length && !r.gabarits.choisis.some((g) => AVEC_QR.includes(g)))
    avertir("Aucun gabarit avec carte et QR : pas de carte, pas de collecte d'e-mails sur la page souvenir.");
  if (r.gabarits.choisis.includes("carte")) avertir("La photo + deux cartes demande un ruban 15x20 dans l'imprimante (DS620).");

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
