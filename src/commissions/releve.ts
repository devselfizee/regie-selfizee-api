import PDFDocument from "pdfkit";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

// Relevé de commission d'un lieu pour une période (CDC §6) : données, PDF, destinataires.

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function chargerReleve(id: number) {
  const r = await prisma.reversement.findUniqueOrThrow({
    where: { id },
    include: {
      lieu: {
        select: {
          id: true, enseigne: true, raisonSociale: true, siret: true, adresse: true, codePostal: true, ville: true,
          contacts: { select: { role: true, nom: true, prenom: true, email: true } },
        },
      },
      contrat: { select: { version: true, dateEffet: true } },
      ajustements: { include: { user: { select: { nom: true, prenom: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
  const parJour = await prisma.$queryRaw<{ jour: Date; nb: number; ca: number; rembourse: number }[]>`
    SELECT jour, sum(nb_acceptees)::int nb, sum(ca_ttc_cents)::float8 ca, sum(rembourse_ttc_cents)::float8 rembourse
    FROM agg_jour WHERE lieu_id = ${r.lieuId} AND jour BETWEEN ${ymd(r.periodeDebut)}::date AND ${ymd(r.periodeFin)}::date
    GROUP BY jour ORDER BY jour`;
  return {
    ...r,
    ventesParJour: parJour.map((j) => ({ jour: ymd(j.jour), nbVentes: j.nb, caTtcCents: Number(j.ca), rembourseTtcCents: Number(j.rembourse) })),
  };
}

export type Releve = Awaited<ReturnType<typeof chargerReleve>>;

interface Detail {
  periode?: string;
  contrat?: string;
  nbVentes?: number;
  lignes?: { libelle: string; baseCents?: number; tauxBp?: number; montantCents: number }[];
}
export const detailDe = (r: { detailCalcul: Prisma.JsonValue }) => (r.detailCalcul ?? {}) as Detail;

/** Contacts du lieu à qui envoyer le relevé : comptabilité d'abord, sinon gérant, sinon tous. */
export function destinatairesParDefaut(r: Releve): string[] {
  const avecEmail = r.lieu.contacts.filter((c) => c.email);
  const compta = avecEmail.filter((c) => c.role === "COMPTABILITE");
  const gerant = avecEmail.filter((c) => c.role === "GERANT");
  return [...new Set((compta.length ? compta : gerant.length ? gerant : avecEmail).map((c) => c.email!.toLowerCase()))];
}

// Les polices standard du PDF ne connaissent pas les espaces fines insécables du format français
const propre = (s: string) => s.replace(/[  ]/g, " ");
const euros = (c: number) =>
  propre(`${(c / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);
const nombre = (n: number) => propre(n.toLocaleString("fr-FR"));
const dateFr = (d: Date | string) => ymd(new Date(d)).split("-").reverse().join("/");

const STATUTS: Record<string, string> = {
  A_CALCULER: "À calculer", CALCULE: "À valider", VALIDE: "Validé",
  FACTURE_PAR_LIEU: "Facturé par le lieu", AUTOFACTURE: "Autofacturé", PAYE: "Payé",
};

/** Génère le relevé en PDF (A4). */
export function genererPdfReleve(r: Releve): Promise<Buffer> {
  const d = detailDe(r);
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Relevé de commission — ${r.lieu.enseigne} — ${d.periode ?? ""}`, Author: "Selfizee" } });
  const morceaux: Buffer[] = [];
  doc.on("data", (m: Buffer) => morceaux.push(m));
  const fin = new Promise<Buffer>((ok) => doc.on("end", () => ok(Buffer.concat(morceaux))));

  const gauche = 48;
  const droite = doc.page.width - 48;
  const largeur = droite - gauche;
  const ACCENT = "#2a78d6";
  const GRIS = "#6f6d68";
  const ligneH = (y: number, couleur = "#e1e0d9") => doc.moveTo(gauche, y).lineTo(droite, y).lineWidth(0.7).strokeColor(couleur).stroke();
  const deuxColonnes = (libelle: string, valeur: string, gras = false, taille = 10) => {
    const y = doc.y;
    doc.font(gras ? "Helvetica-Bold" : "Helvetica").fontSize(taille).fillColor("#0b0b0b");
    doc.text(propre(libelle), gauche, y, { width: largeur - 120 });
    const hauteur = doc.y - y;
    doc.text(valeur, droite - 120, y, { width: 120, align: "right" });
    doc.y = y + Math.max(hauteur, doc.currentLineHeight()) + 5;
  };

  // En-tête
  doc.font("Helvetica-Bold").fontSize(9).fillColor(ACCENT).text("SELFIZEE · RÉGIE", gauche, 48);
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#0b0b0b").text("Relevé de commission", gauche, 62);
  doc.font("Helvetica").fontSize(12).fillColor(GRIS).text(propre(capitaliser(d.periode ?? "")), gauche, 88);
  const adresse = [r.lieu.adresse, [r.lieu.codePostal, r.lieu.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0b0b0b").text(propre(r.lieu.raisonSociale), gauche, 50, { width: largeur, align: "right" });
  doc.font("Helvetica").fontSize(10).text(propre(r.lieu.enseigne), { width: largeur, align: "right" });
  if (adresse) doc.fillColor(GRIS).text(propre(adresse), { width: largeur, align: "right" });
  if (r.lieu.siret) doc.fillColor(GRIS).text(`SIRET ${r.lieu.siret}`, { width: largeur, align: "right" });
  doc.y = Math.max(doc.y, 110) + 8;
  ligneH(doc.y);
  doc.moveDown(1);

  // Chiffres clés
  const yChiffres = doc.y;
  const bloc = largeur / 3;
  [["Ventes", nombre(d.nbVentes ?? 0)], ["CA TTC", euros(r.caTtcCents)], ["Remboursements", euros(r.rembourseCents)]].forEach(([l, v], i) => {
    const x = gauche + i * bloc;
    doc.roundedRect(x, yChiffres, bloc - 8, 48, 4).fillColor("#f3f2ee").fill();
    doc.font("Helvetica").fontSize(9).fillColor(GRIS).text(l, x + 10, yChiffres + 9);
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#0b0b0b").text(v, x + 10, yChiffres + 23);
  });
  doc.y = yChiffres + 64;

  // Calcul
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0b0b0b").text("Calcul de la commission", gauche, doc.y);
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(9.5).fillColor(GRIS)
    .text(propre(`Contrat (version ${r.contrat.version}, en vigueur depuis le ${dateFr(r.contrat.dateEffet)}) : ${d.contrat ?? ""}`), gauche, doc.y, { width: largeur });
  doc.moveDown(0.6);
  deuxColonnes("Base de calcul", euros(r.baseCalculCents));
  for (const l of d.lignes ?? []) {
    const detail = l.baseCents !== undefined && l.tauxBp !== undefined ? ` — ${nombre(l.tauxBp / 100)} % × ${euros(l.baseCents)}` : "";
    deuxColonnes(l.libelle + detail, l.montantCents ? euros(l.montantCents) : "");
  }
  ligneH(doc.y);
  doc.moveDown(0.4);
  deuxColonnes("Commission calculée", euros(r.commissionCalculeeCents), true);
  for (const a of r.ajustements) {
    deuxColonnes(`Correction : ${a.motif} (${[a.user.prenom, a.user.nom].filter(Boolean).join(" ")}, ${dateFr(a.createdAt)})`, euros(a.montantCents));
  }
  ligneH(doc.y, "#c3c2b7");
  doc.moveDown(0.5);
  deuxColonnes("Montant à reverser", euros(r.montantAReverserCents), true, 13);
  doc.font("Helvetica").fontSize(9).fillColor(GRIS)
    .text([`Statut : ${STATUTS[r.statut] ?? r.statut}`, r.numeroFacture ? `facture ${r.numeroFacture}` : null, r.payeLe ? `payé le ${dateFr(r.payeLe)}` : null].filter(Boolean).join(" · "), gauche, doc.y);
  doc.moveDown(1.2);

  // Ventes par jour
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0b0b0b").text("Détail des ventes par jour", gauche, doc.y);
  doc.moveDown(0.4);
  const cols = [gauche, gauche + 150, gauche + 270, gauche + 390];
  const entete = () => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(GRIS);
    const y = doc.y;
    doc.text("Date", cols[0], y);
    doc.text("Ventes", cols[1], y, { width: 90, align: "right" });
    doc.text("CA TTC", cols[2], y, { width: 100, align: "right" });
    doc.text("Remboursé", cols[3], y, { width: droite - cols[3], align: "right" });
    doc.y = y + 14;
    ligneH(doc.y - 3);
  };
  entete();
  if (!r.ventesParJour.length) doc.font("Helvetica").fontSize(9.5).fillColor(GRIS).text("Aucune vente sur la période.", gauche, doc.y);
  for (const v of r.ventesParJour) {
    if (doc.y > doc.page.height - 80) {
      doc.addPage();
      entete();
    }
    const y = doc.y;
    doc.font("Helvetica").fontSize(9.5).fillColor("#0b0b0b");
    doc.text(dateFr(v.jour), cols[0], y);
    doc.text(nombre(v.nbVentes), cols[1], y, { width: 90, align: "right" });
    doc.text(euros(v.caTtcCents), cols[2], y, { width: 100, align: "right" });
    doc.fillColor(GRIS).text(v.rembourseTtcCents ? euros(v.rembourseTtcCents) : "—", cols[3], y, { width: droite - cols[3], align: "right" });
    doc.y = y + 14;
  }

  // Pied de page
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(8).fillColor(GRIS).text(
    `Relevé établi le ${dateFr(r.calculeLe ?? new Date())} à partir des ventes enregistrées par les bornes Selfizee installées dans l'établissement.`,
    gauche, doc.y, { width: largeur }
  );

  doc.end();
  return fin;
}

const capitaliser = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Nom de fichier du relevé : releve_camping-les-flots-bleus_2026-08.pdf */
export function nomFichierReleve(r: Releve) {
  const lieu = r.lieu.enseigne.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `releve_${lieu}_${ymd(r.periodeDebut).slice(0, 7)}.pdf`;
}
