// Les mails de la page souvenir (CDC page souvenir § 6, maquette docs/maquettes/mail-photos-v1.html) :
// 1. livraison des photos, 2. code gagné à la carte à gratter, 3. lien « Toutes tes photos », plus le mail
// « on n'a pas retrouvé ta photo » (§ 4.1, photo toujours absente 24 h après l'inscription).
// HTML « mail » : tables, styles en ligne, Arial, pas de script, images hébergées. Les ombres et dégradés de la
// maquette sont ignorés par Outlook, qui garde une mise en page lisible.
// Ici, seulement la mise en forme : les données sont préparées par envois.ts.

export type LotGagne = "free" | "pct50" | "pct30";

export interface Pied {
  /** Logo hébergé (PNG, 200 × 38) */
  logo: string;
  viePrivee: string;
  /** Lien « Supprimer mes photos » (§ 9.3) ; absent du mail 3, qui couvre plusieurs séances */
  oubli?: string;
  /** « Tu reçois ce mail parce que… » */
  raison: string;
}

export interface MailPret {
  sujet: string;
  html: string;
  texte: string;
}

const FUSEAU = "Europe/Paris";
const jourMois = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, day: "numeric", month: "long" }).format(d);
const jourMoisAn = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, day: "numeric", month: "long", year: "numeric" }).format(d);
const heure = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, hour: "2-digit", minute: "2-digit" }).format(d).replace(/\s?h\s?/, ":");
const court = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, day: "2-digit", month: "2-digit", year: "2-digit" }).format(d).replace(/\//g, ".");
export const euros = (v: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(v).replace(/ /g, " ");

/** Échappement HTML de tout ce qui vient de la base (nom du lieu, prénom…). */
export const h = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** « La Ruche, Trégueux » */
export const lieuEtVille = (lieu: string, ville: string) => (ville ? `${lieu}, ${ville}` : lieu);

/** Raison du pied des mails liés à une séance. */
export const raisonSeance = (lieu: string, ville: string, date: Date) =>
  `Tu reçois ce mail parce que tu as demandé tes photos sur une borne Selfizee à ${lieuEtVille(lieu, ville)}, le ${jourMoisAn(date)}.`;

const ARIAL = "font-family:Arial,Helvetica,sans-serif;";
const NOIR = "font-family:'Arial Black',Arial,Helvetica,sans-serif;font-weight:900;";

function gabarit(preEntete: string, lignes: string, pied: Pied): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Selfizee</title></head>
<body style="margin:0;padding:0;background:#0f0918;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#0f0918;">${h(preEntete)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0f0918;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#0f0918;color:#f7f1ff;${ARIAL}">
  <tr><td align="center" style="padding:0 0 26px;"><img src="${h(pied.logo)}" width="200" height="38" alt="Selfizee" style="display:block;border:0;"></td></tr>
${lignes}
  <tr><td align="center" style="padding:26px 0 0;border-top:1px solid #2a1f3d;${ARIAL}font-size:12px;line-height:1.6;color:#9d8fb8;">
    <img src="${h(pied.logo)}" width="90" height="17" alt="Selfizee" style="display:inline-block;border:0;opacity:.7;"><br>
    Selfizee SAS · photobooth · contact@selfizee.fr<br>
    ${h(pied.raison)}<br>
    Photos et e-mail conservés 90 jours, puis effacés. <a href="${h(pied.viePrivee)}" style="color:#9d8fb8;">Vie privée</a>${pied.oubli ? ` · <a href="${h(pied.oubli)}" style="color:#9d8fb8;">Supprimer mes photos</a>` : ""}
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

const titre = (html: string, bas = 8) =>
  `  <tr><td align="center" style="padding:0 0 ${bas}px;${NOIR}font-size:36px;line-height:1.08;text-transform:uppercase;color:#ffe14d;text-shadow:4px 4px 0 #ff3da8;">${html}</td></tr>`;
const ligne = (html: string, style: string) => `  <tr><td align="center" style="${style}">${html}</td></tr>`;

function bouton(lien: string, libelle: string, jaune = false): string {
  const fond = jaune ? "#ffe14d" : "#1b1300";
  const bord = jaune ? "#b89a00" : "#000";
  const couleur = jaune ? "#1b1300" : "#ffe14d";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="${fond}" style="border-radius:999px;border-bottom:4px solid ${bord};"><a href="${h(lien)}" style="display:block;padding:14px 28px;${ARIAL}font-weight:bold;font-size:14px;color:${couleur};text-decoration:none;text-transform:uppercase;letter-spacing:.3px;">${h(libelle)}</a></td></tr></table>`;
}

function bloc(contenu: string, fond: string): string {
  return `  <tr><td style="padding:0 0 18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${fond}" style="padding:26px 22px;border-radius:14px;">
${contenu}
    </td></tr></table>
  </td></tr>`;
}

/** Trois petits tirages côte à côte (la maquette les fait pivoter en CSS, ignoré par les clients mail). */
function eventail(images: string[], largeur: number): string {
  const cases = images
    .slice(0, 3)
    .map(
      (src) =>
        `<td style="padding:0 4px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#ffffff" style="padding:4px 4px 12px;"><img src="${h(src)}" width="${largeur}" alt="" style="display:block;border:0;width:${largeur}px;height:auto;"></td></tr></table></td>`
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>${cases}</tr></table>`;
}

// ─── Mail 1 : livraison (§ 6.1) ───

export interface DonneesLivraison {
  lieu: string;
  ville: string;
  date: Date;
  /** Page souvenir de la séance */
  page: string;
  /** Code de séance imprimé ; absent : ni bloc de réimpression ni rappel du code (§ 11) */
  codeSeance?: string;
  /** Prix minimum de la grille, en euros */
  prixMin?: number;
  /** Aperçu hébergé de la photo (500 px), distinct de la pièce jointe */
  apercu?: string;
  /** Lien (suivi) vers l'avis Google ; absent : pas de bloc avis */
  avis?: string;
  instagram: string;
  tiktok: string;
  /** Texte du bloc partage (@selfizee par défaut) */
  hashtag: string;
  avecGif: boolean;
  pied: Pied;
}

export function mailLivraison(d: DonneesLivraison): MailPret {
  const lieu = h(d.lieu);
  const code = d.codeSeance ? h(d.codeSeance) : null;
  const pj = d.avecGif ? "Ta photo et ton GIF sont en pièces jointes. Mets-les partout." : "Ta photo est en pièce jointe. Mets-la partout.";
  const lignes = [
    titre("Tes photos<br>sont là."),
    ligne(`${h(lieuEtVille(d.lieu, d.ville))} · ${jourMois(d.date)} · ${heure(d.date)}`, `padding:0 0 24px;${ARIAL}font-size:16px;line-height:1.4;color:#f7f1ff;`),
    d.apercu
      ? `  <tr><td align="center" style="padding:16px 0 26px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="270" style="box-shadow:10px 10px 0 #ff3da8;"><tr><td bgcolor="#ffffff" style="padding:10px 10px 12px;">
      <img src="${h(d.apercu)}" width="250" alt="Ta photo" style="display:block;border:0;width:250px;height:auto;">
      <div style="padding-top:10px;${ARIAL}font-size:10px;letter-spacing:1px;color:#1b1300;text-transform:uppercase;text-align:center;">Selfizee × ${lieu} · ${court(d.date)}</div>
    </td></tr></table>
  </td></tr>`
      : "",
    ligne(pj, `padding:0 0 6px;${ARIAL}font-size:15px;font-weight:bold;color:#f7f1ff;`),
    ligne(
      `Toutes tes photos restent 90 jours sur <a href="${h(d.page)}" style="color:#ffe14d;font-weight:bold;">ta page</a>.` +
        (code ? `<br>Ton code, si tu n'as plus le lien : <b style="color:#f7f1ff;font-family:'Courier New',monospace;letter-spacing:3px;font-size:16px;">${code}</b>` : ""),
      `padding:0 0 34px;${ARIAL}font-size:13px;line-height:1.6;color:#cbbfe0;`
    ),
    code
      ? bloc(
          `${d.apercu ? `      <div style="padding:0 0 14px;">${eventail([d.apercu, d.apercu, d.apercu], 72)}</div>\n` : ""}      <div style="${NOIR}font-size:17px;line-height:1.2;text-transform:uppercase;color:#f7f1ff;">Réimprime ta photo<br>pour un pote</div>
      <div style="padding:10px 0 4px;${ARIAL}font-size:14px;line-height:1.55;color:#cbbfe0;">Elle est trop bien pour rester seule : un tirage de plus pour chacun. Sur l'écran d'accueil de la borne, appuie sur <b style="color:#f7f1ff;">Réimprimer</b> et tape ton code <b style="color:#f7f1ff;font-family:'Courier New',monospace;letter-spacing:2px;">${code}</b>.${d.prixMin ? ` Dès ${euros(d.prixMin)}.` : ""}</div>`,
          "#2b1d44"
        )
      : "",
    d.avis
      ? bloc(
          `      <div style="${NOIR}font-size:17px;line-height:1.2;text-transform:uppercase;color:#1b1300;">Tu as aimé ta soirée<br>à ${lieu} ?</div>
      <div style="padding:10px 0 2px;font-size:26px;letter-spacing:4px;color:#e0a800;line-height:1;">★★★★★</div>
      <div style="padding:10px 0 18px;${ARIAL}font-size:14px;line-height:1.55;color:#4a3f1a;">Dis-le avec un avis Google : ça fait du bien au lieu, et c'est grâce à lui que la borne est là.</div>
      ${bouton(d.avis, "Je laisse mon avis")}`,
          "#fdf4cf"
        )
      : "",
    bloc(
      `      <div style="${NOIR}font-size:17px;line-height:1.2;text-transform:uppercase;color:#1b1300;">Partage tes photos</div>
      <div style="padding:10px 0 18px;${ARIAL}font-size:14px;line-height:1.55;color:#4a3f1a;">En story ou en post, taggue <b>${h(d.hashtag)}</b> et le lieu : on repartage les plus belles.</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td bgcolor="#1b1300" style="border-radius:999px;"><a href="${h(d.instagram)}" style="display:block;padding:10px 20px;${ARIAL}font-weight:bold;font-size:13px;color:#ffe14d;text-decoration:none;">Instagram</a></td><td width="10"></td><td bgcolor="#1b1300" style="border-radius:999px;"><a href="${h(d.tiktok)}" style="display:block;padding:10px 20px;${ARIAL}font-weight:bold;font-size:13px;color:#ffe14d;text-decoration:none;">TikTok</a></td></tr></table>`,
      "#fdf4cf"
    ),
    ligne(
      `Un mot sur la borne, un souci avec ta photo ? <a href="mailto:contact@selfizee.fr?subject=${encodeURIComponent(`Ma photo à ${d.lieu}`)}" style="color:#ffe14d;font-weight:bold;">Dis-nous tout</a>, ça prend une minute.`,
      `padding:10px 0 30px;${ARIAL}font-size:13px;line-height:1.5;color:#cbbfe0;`
    ),
  ];
  const texte = [
    "TES PHOTOS SONT LÀ.",
    `${lieuEtVille(d.lieu, d.ville)} · ${jourMois(d.date)} · ${heure(d.date)}`,
    "",
    d.avecGif ? "Ta photo et ton GIF sont en pièces jointes." : "Ta photo est en pièce jointe.",
    `Toutes tes photos restent 90 jours sur ta page : ${d.page}`,
    ...(d.codeSeance ? [`Ton code, si tu n'as plus le lien : ${d.codeSeance}`, "", `Réimprime ta photo pour un pote : sur l'écran d'accueil de la borne, appuie sur Réimprimer et tape ton code ${d.codeSeance}.${d.prixMin ? ` Dès ${euros(d.prixMin)}.` : ""}`] : []),
    ...(d.avis ? ["", `Tu as aimé ta soirée à ${d.lieu} ? Laisse un avis Google : ${d.avis}`] : []),
    "",
    `Partage tes photos : taggue ${d.hashtag} et le lieu. Instagram : ${d.instagram} · TikTok : ${d.tiktok}`,
    "",
    ...piedTexte(d.pied),
  ].join("\n");
  return {
    sujet: `Tes photos de ${d.lieu} sont là`,
    html: gabarit(d.avecGif ? "Photo et GIF en pièces jointes, toutes tes photos sur ta page." : "Ta photo en pièce jointe, toutes tes photos sur ta page.", lignes.filter(Boolean).join("\n"), d.pied),
    texte,
  };
}

// ─── Mail 2 : code gagné (§ 6.2) ───

export interface DonneesCode {
  lot: LotGagne;
  code: string;
  /** Trois photos d'exemple hébergées (éventail) */
  illustrations: string[];
  pied: Pied;
}

const GAINS: Record<LotGagne, { sujet: string; ticket: string; fin: string }> = {
  free: { sujet: "Gagné : ta prochaine photo est offerte", ticket: "Ta prochaine photo<br>est offerte", fin: "zéro euro, grand sourire" },
  pct50: { sujet: "Gagné : -50 % sur ta prochaine photo", ticket: "-50 % sur ta<br>prochaine photo", fin: "moitié prix, double sourire" },
  pct30: { sujet: "Gagné : -30 % sur ta prochaine photo", ticket: "-30 % sur ta<br>prochaine photo", fin: "-30 % sur ton tirage" },
};

export function mailCode(d: DonneesCode): MailPret {
  const g = GAINS[d.lot];
  const lignes = [
    titre("Gagné."),
    ligne("Ta carte à gratter a parlé : la prochaine, c'est pour nous.", `padding:0 0 18px;${ARIAL}font-size:16px;line-height:1.4;color:#f7f1ff;`),
    d.illustrations.length ? `  <tr><td align="center" style="padding:0 0 22px;">${eventail(d.illustrations, 84)}</td></tr>` : "",
    `  <tr><td style="padding:28px 20px 26px;background:#fdf4cf;border-radius:14px;" bgcolor="#fdf4cf" align="center">
    <div style="${NOIR}font-size:22px;line-height:1.15;text-transform:uppercase;color:#1b1300;">${g.ticket}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin-top:16px;"><tr><td bgcolor="#1b1300" style="border-radius:12px;padding:12px 22px;font-family:'Courier New',monospace;font-weight:bold;font-size:28px;letter-spacing:5px;color:#ffe14d;">${h(d.code)}</td></tr></table>
    <div style="padding:14px 0 0;${ARIAL}font-size:12px;line-height:1.5;color:#4a3f1a;">Code unique · 1 photo · valable 30 jours<br>sur toutes les bornes Selfizee des lieux partenaires</div>
  </td></tr>`,
    ligne(`À la borne, fais ta photo et tape ce code au moment de payer : <b>${g.fin}</b>.`, `padding:26px 0 30px;${ARIAL}font-size:15px;line-height:1.5;color:#f7f1ff;`),
  ];
  const texte = [
    "GAGNÉ.",
    "Ta carte à gratter a parlé : la prochaine, c'est pour nous.",
    "",
    `${g.ticket.replace("<br>", " ").toUpperCase()} : ${d.code}`,
    "Code unique · 1 photo · valable 30 jours sur toutes les bornes Selfizee des lieux partenaires.",
    `À la borne, fais ta photo et tape ce code au moment de payer : ${g.fin}.`,
    "",
    ...piedTexte(d.pied),
  ].join("\n");
  return { sujet: g.sujet, html: gabarit(`Ton code : ${d.code}`, lignes.filter(Boolean).join("\n"), d.pied), texte };
}

// ─── Mail 3 : lien « Toutes tes photos » (§ 6.3) ───

export interface DonneesToutes {
  nombre: number;
  lieux: string[];
  lien: string;
  pied: Pied;
}

/** « La Ruche », « La Ruche et Le QG », « A, B et C » */
const enumerer = (l: string[]) => (l.length <= 1 ? (l[0] ?? "") : `${l.slice(0, -1).join(", ")} et ${l.at(-1)}`);

export function mailToutes(d: DonneesToutes): MailPret {
  const photos = `${d.nombre} photo${d.nombre > 1 ? "s" : ""} sur 90 jours${d.lieux.length ? `, à ${enumerer(d.lieux)}` : ""}.`;
  const lignes = [
    titre("Toutes<br>tes photos."),
    ligne(`${h(photos)}<br>Le lien est valable 24 h.`, `padding:0 0 24px;${ARIAL}font-size:16px;line-height:1.5;color:#f7f1ff;`),
    `  <tr><td align="center" style="padding:0 0 30px;">${bouton(d.lien, "Voir toutes mes photos", true)}</td></tr>`,
  ];
  const texte = ["TOUTES TES PHOTOS.", photos, "Le lien est valable 24 h :", d.lien, "", ...piedTexte(d.pied)].join("\n");
  return { sujet: "Toutes tes photos Selfizee", html: gabarit("Le lien est valable 24 h.", lignes.join("\n"), d.pied), texte };
}

// ─── Photo introuvable (§ 4.1) ───

export interface DonneesIntrouvable {
  lieu: string;
  ville: string;
  date: Date;
  page: string;
  pied: Pied;
}

export function mailIntrouvable(d: DonneesIntrouvable): MailPret {
  const ou = lieuEtVille(d.lieu, d.ville);
  const corps = `Tu as demandé tes photos à ${ou}, le ${jourMoisAn(d.date)}, mais la borne ne nous les a pas encore envoyées.`;
  const lignes = [
    titre("On cherche<br>ta photo.", 16),
    ligne(h(corps), `padding:0 0 14px;${ARIAL}font-size:16px;line-height:1.5;color:#f7f1ff;`),
    ligne(
      `Écris-nous à <a href="mailto:contact@selfizee.fr" style="color:#ffe14d;font-weight:bold;">contact@selfizee.fr</a> avec le code imprimé sur ton tirage : on la retrouve. Si elle arrive entre-temps, elle part toute seule vers cette adresse.`,
      `padding:0 0 30px;${ARIAL}font-size:14px;line-height:1.55;color:#cbbfe0;`
    ),
  ];
  const texte = [
    "ON CHERCHE TA PHOTO.",
    corps,
    "Écris-nous à contact@selfizee.fr avec le code imprimé sur ton tirage : on la retrouve. Si elle arrive entre-temps, elle part toute seule vers cette adresse.",
    "",
    ...piedTexte(d.pied),
  ].join("\n");
  return { sujet: "On n'a pas retrouvé ta photo", html: gabarit("La borne ne nous l'a pas encore envoyée.", lignes.join("\n"), d.pied), texte };
}

function piedTexte(p: Pied): string[] {
  return [
    "—",
    "Selfizee SAS · photobooth · contact@selfizee.fr",
    p.raison,
    "Photos et e-mail conservés 90 jours, puis effacés.",
    `Vie privée : ${p.viePrivee}`,
    ...(p.oubli ? [`Supprimer mes photos : ${p.oubli}`] : []),
  ];
}
