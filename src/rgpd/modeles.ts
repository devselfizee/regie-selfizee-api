import { prisma } from "../lib/prisma.js";
import { h } from "../souvenir/mails.js";

// Mails de la plateforme RGPD, paramétrables dans la Régie (Paramètres → E-mails RGPD) : sujet, corps en texte riche
// (gras, italique, listes) et, pour la notification interne, ses destinataires. Les variables {{…}} sont remplacées à
// l'envoi ; leur valeur est échappée, sauf le bouton du lien, construit ici. Sans réglage en base, le texte par défaut
// ci-dessous s'applique (repris du mail du booth).

export const CLES_MODELES = ["RGPD_ACCES", "RGPD_NOTIFICATION"] as const;
export type CleModele = (typeof CLES_MODELES)[number];

interface Definition {
  nom: string;
  description: string;
  /** La notification interne a des destinataires réglables ; le lien d'accès part à l'adresse demandée. */
  avecDestinataires: boolean;
  variables: { nom: string; description: string }[];
  sujet: string;
  corps: string;
  destinataires: string | null;
}

export const MODELES: Record<CleModele, Definition> = {
  RGPD_ACCES: {
    nom: "Lien d'accès aux données",
    description: "Envoyé à la personne qui demande l'accès à ses données sur la plateforme RGPD, si son adresse est connue de la Régie.",
    avecDestinataires: false,
    variables: [
      { nom: "lien", description: "Bouton « Accéder à mes données » (ajouté en fin de mail s'il manque)" },
      { nom: "validite", description: "Durée de validité du lien (7 jours)" },
      { nom: "plateforme", description: "Lien vers la plateforme RGPD" },
      { nom: "email", description: "Adresse de la personne" },
    ],
    sujet: "Votre accès à la gestion de vos données — Selfizee",
    corps: [
      "<p>Bonjour,</p>",
      "<p>Suite à votre demande, voici votre lien d'accès personnel pour consulter et gérer les données collectées vous concernant sur les bornes photo Selfizee.</p>",
      "<p>{{lien}}</p>",
      "<p><b>Ce lien est valable {{validite}}.</b> Passé ce délai, il vous suffira de refaire une demande sur notre plateforme RGPD : {{plateforme}}.</p>",
      "<p>Vous y retrouverez également notre politique de traitement des données ainsi que notre charte de conformité au RGPD.</p>",
      "<p>Nous vous remercions pour votre confiance.</p>",
      "<p>L'équipe Selfizee</p>",
    ].join(""),
    destinataires: null,
  },
  RGPD_NOTIFICATION: {
    nom: "Notification interne (suppression, modification)",
    description: "Envoyée à l'équipe quand une personne supprime ou modifie ses données depuis la plateforme RGPD. Sans destinataire, rien n'est envoyé.",
    avecDestinataires: true,
    variables: [
      { nom: "action", description: "« suppression » ou « modification »" },
      { nom: "email", description: "Adresse de la personne" },
      { nom: "evenements", description: "Lieux et événements concernés" },
      { nom: "date", description: "Date et heure de la demande" },
      { nom: "details", description: "Ce qui a été supprimé ou modifié, ligne par ligne" },
    ],
    sujet: "RGPD : {{action}} des données de {{email}}",
    corps: [
      "<p>Bonjour,</p>",
      "<p>Une personne vient de faire une <b>{{action}}</b> de ses données depuis la plateforme RGPD.</p>",
      "<p>Adresse : {{email}}<br>Concerne : {{evenements}}<br>Date : {{date}}</p>",
      "<p>{{details}}</p>",
      "<p>Si ces données ont été exportées (contacts opt-in d'un lieu, fichier d'un client), pensez à les retirer aussi.</p>",
    ].join(""),
    destinataires: "dpo@selfizee.fr",
  },
};

export const estCleModele = (v: string): v is CleModele => (CLES_MODELES as readonly string[]).includes(v);

export interface ModeleCourant {
  cle: CleModele;
  sujet: string;
  corps: string;
  destinataires: string | null;
  parDefaut: boolean;
  modifieLe: string | null;
  modifiePar: string | null;
}

/** Le modèle tel qu'il partira : réglage en base, sinon le texte par défaut. */
export async function lireModele(cle: CleModele): Promise<ModeleCourant> {
  const m = await prisma.modeleMail.findUnique({ where: { cle }, include: { modifiePar: { select: { prenom: true, nom: true } } } });
  const d = MODELES[cle];
  if (!m) return { cle, sujet: d.sujet, corps: d.corps, destinataires: d.destinataires, parDefaut: true, modifieLe: null, modifiePar: null };
  return {
    cle,
    sujet: m.sujet,
    corps: m.corps,
    destinataires: m.destinataires,
    parDefaut: false,
    modifieLe: m.updatedAt.toISOString(),
    modifiePar: m.modifiePar ? `${m.modifiePar.prenom} ${m.modifiePar.nom}`.trim() : null,
  };
}

/** « a@x.fr, b@y.fr ; c@z.fr » → adresses valides, sans doublon. */
export function listeAdresses(v: string | null | undefined): string[] {
  return [...new Set((v ?? "").split(/[,;\s]+/).map((a) => a.trim().toLowerCase()).filter((a) => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(a)))];
}

/** Valeur d'une variable : texte (échappé à l'envoi), et HTML déjà construit quand il en faut un (bouton, lien). */
export type Variables = Record<string, { texte: string; html?: string }>;

export interface MailRgpd {
  sujet: string;
  html: string;
  texte: string;
}

const ROSE = "#ed195f";
const ARIAL = "font-family:Arial,Helvetica,sans-serif;";

/** Bouton du lien, en tableau pour Outlook. */
export function bouton(url: string, libelle: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0;"><tr><td style="background:${ROSE};border-radius:8px;">`
    + `<a href="${h(url)}" style="display:inline-block;padding:14px 30px;${ARIAL}font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${h(libelle)}</a>`
    + `</td></tr></table>`;
}

const remplacer = (gabarit: string, vars: Variables, enHtml: boolean) =>
  gabarit.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (tout, nom: string) => {
    const v = vars[nom];
    if (!v) return enHtml ? h(tout) : tout; // variable inconnue : laissée telle quelle, visible à l'essai
    return enHtml ? (v.html ?? h(v.texte)) : v.texte;
  });

/** Texte brut d'un corps HTML (version texte du mail). */
export const versTexte = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|table)>/gi, "\n\n")
    .replace(/<\/(li|tr)>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Met le modèle en forme : variables remplacées, corps dans la mise en page Selfizee (bandeau rose, carte blanche).
 * `lien` : URL du bouton, ajouté en fin de corps si le modèle n'a pas {{lien}}, avec l'adresse en clair dessous.
 */
export function rendreModele(m: Pick<ModeleCourant, "sujet" | "corps">, vars: Variables, lien?: { url: string; libelle: string }): MailRgpd {
  const toutes: Variables = lien ? { ...vars, lien: { texte: lien.url, html: bouton(lien.url, lien.libelle) } } : vars;
  let corps = remplacer(m.corps, toutes, true);
  if (lien && !/\{\{\s*lien\s*\}\}/.test(m.corps)) corps += bouton(lien.url, lien.libelle);
  const secours = lien
    ? `<p style="margin:20px 0 0;font-size:13px;color:#8a8a8a;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><a href="${h(lien.url)}" style="color:${ROSE};word-break:break-all;">${h(lien.url)}</a></p>`
    : "";
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Selfizee</title></head>
<body style="margin:0;padding:0;background:#f4f1f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1f6;">
<tr><td align="center" style="padding:28px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
  <tr><td style="background:${ROSE};padding:18px 28px;${ARIAL}font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:.5px;">Selfizee</td></tr>
  <tr><td style="padding:28px;${ARIAL}font-size:15px;line-height:1.6;color:#474747;">${corps}${secours}</td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #eee;${ARIAL}font-size:12px;line-height:1.5;color:#9a9a9a;">Selfizee · SAS Konitys · dpo@selfizee.fr</td></tr>
</table>
</td></tr></table>
</body></html>`;
  // Version texte : mêmes variables, le bouton devient « Accéder à mes données : https://… »
  const enTexte: Variables = lien ? { ...vars, lien: { texte: `${lien.libelle} : ${lien.url}` } } : vars;
  let texte = versTexte(remplacer(m.corps, enTexte, true));
  if (lien && !/\{\{\s*lien\s*\}\}/.test(m.corps)) texte += `\n\n${lien.libelle} : ${lien.url}`;
  return { sujet: remplacer(m.sujet, toutes, false).replace(/[\r\n]+/g, " ").slice(0, 200), html, texte };
}
