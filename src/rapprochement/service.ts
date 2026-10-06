import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import { localParis } from "../alertes/ouverture.js";
import { chargerRegles } from "../alertes/regles.js";
import { lever } from "../alertes/evaluation.js";
import { notifierAlertes } from "../alertes/notifications.js";
import { apparier, type VenteAApparier } from "./moteur.js";
import type { LigneReleve } from "./csv.js";

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const eur = (c: number) => `${(c / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Vente signée côté relevé : un remboursement est un débit. */
const montantSigne = (t: { statut: string; montantTtcCents: number }) =>
  t.statut === "REMBOURSEE" ? -Math.abs(t.montantTtcCents) : t.montantTtcCents;

/** Terminal (TID) → bornes : modules dont l'identifiant prestataire ou le n° de série correspond, sinon identifiant de borne. */
async function bornesDesTerminaux(terminaux: string[]) {
  const [modules, bornes] = await Promise.all([
    prisma.modulePaiement.findMany({
      where: { borneId: { not: null }, OR: [{ identifiantPrestataire: { in: terminaux } }, { numeroSerie: { in: terminaux } }] },
      select: { borneId: true, identifiantPrestataire: true, numeroSerie: true },
    }),
    prisma.borne.findMany({ where: { identifiant: { in: terminaux } }, select: { id: true, identifiant: true } }),
  ]);
  const parTerminal = new Map<string, Set<number>>();
  for (const t of terminaux) {
    const ids = new Set<number>();
    for (const m of modules) if (m.identifiantPrestataire === t || m.numeroSerie === t) ids.add(m.borneId!);
    if (!ids.size) for (const b of bornes) if (b.identifiant === t) ids.add(b.id);
    if (ids.size) parTerminal.set(t, ids);
  }
  return parTerminal;
}

/** Ventes susceptibles de figurer sur un relevé : carte (pas espèces), acceptées ou remboursées. */
const ventesCarte = (borneIds: number[]): Prisma.TransactionWhereInput => ({
  borneId: { in: borneIds },
  statut: { in: ["ACCEPTEE", "REMBOURSEE"] },
  moyenPaiement: { not: "ESPECES" },
});

/** Apparie les lignes encore libres du relevé (relançable quand des ventes arrivent en retard). */
export async function rapprocher(releveId: number) {
  const lignes = await prisma.releveLigne.findMany({ where: { releveId, transactionId: null } });
  const terminaux = [...new Set(lignes.map((l) => l.identifiantPrestataire))];
  const bornes = await bornesDesTerminaux(terminaux);
  const appariements: { ligneId: bigint; transactionId: bigint; statut: "RAPPROCHE" | "ECART" }[] = [];

  for (const [terminal, borneIds] of bornes) {
    const lignesTerminal = lignes
      .filter((l) => l.identifiantPrestataire === terminal)
      .map((l) => ({ id: l.id, horodatage: l.horodatage, montantCents: l.montantCents, reference: l.referenceMonetique }));
    const min = Math.min(...lignesTerminal.map((l) => l.horodatage.getTime()));
    const max = Math.max(...lignesTerminal.map((l) => l.horodatage.getTime()));
    const ventes: VenteAApparier[] = (
      await prisma.transaction.findMany({
        where: {
          ...ventesCarte([...borneIds]),
          rapprochement: "NON_RAPPROCHE",
          horodatage: { gte: new Date(min - JOUR), lte: new Date(max + JOUR) },
        },
        select: { id: true, horodatage: true, statut: true, montantTtcCents: true, referenceMonetique: true },
      })
    ).map((t) => ({ id: t.id, horodatage: t.horodatage, montantCents: montantSigne(t), reference: t.referenceMonetique }));
    appariements.push(...apparier(lignesTerminal, ventes));
  }

  if (appariements.length) {
    const ids = appariements.map((a) => a.ligneId.toString());
    const transactions = appariements.map((a) => a.transactionId.toString());
    const statuts = appariements.map((a) => a.statut);
    await prisma.$transaction([
      prisma.$executeRaw`
        UPDATE releve_lignes r SET transaction_id = v.t::bigint, statut = v.s::"RapprochementStatut"
        FROM unnest(${ids}::text[], ${transactions}::text[], ${statuts}::text[]) AS v(id, t, s)
        WHERE r.id = v.id::bigint`,
      prisma.$executeRaw`
        UPDATE transactions a SET rapprochement = v.s::"RapprochementStatut"
        FROM unnest(${transactions}::text[], ${statuts}::text[]) AS v(t, s)
        WHERE a.id = v.t::bigint`,
    ]);
  }
  return appariements.length;
}

/** Enregistre le relevé (sans les lignes déjà importées par un autre relevé) puis le rapproche. */
export async function importerReleve(fournisseur: string, fichierNom: string, lignes: LigneReleve[]) {
  if (!lignes.length) throw new HttpError(400, "RELEVE_VIDE", "Aucune ligne exploitable dans le fichier");
  const temps = lignes.map((l) => l.horodatage.getTime());
  const debut = new Date(Math.min(...temps));
  const fin = new Date(Math.max(...temps));

  // Lignes déjà présentes (même terminal, instant, montant) : fichier réimporté ou périodes qui se chevauchent
  const existantes = await prisma.releveLigne.findMany({
    where: { identifiantPrestataire: { in: [...new Set(lignes.map((l) => l.terminal))] }, horodatage: { gte: debut, lte: fin } },
    select: { identifiantPrestataire: true, horodatage: true, montantCents: true },
  });
  const cle = (t: string, h: Date, m: number) => `${t}|${h.getTime()}|${m}`;
  const deja = new Set(existantes.map((e) => cle(e.identifiantPrestataire, e.horodatage, e.montantCents)));
  const nouvelles = lignes.filter((l) => !deja.has(cle(l.terminal, l.horodatage, l.montantCents)));
  if (!nouvelles.length) throw new HttpError(409, "RELEVE_DEJA_IMPORTE", "Toutes les lignes de ce fichier ont déjà été importées");

  const releve = await prisma.releveMonetique.create({
    data: {
      fournisseur,
      fichierNom,
      periodeDebut: localParis(debut).jour,
      periodeFin: localParis(fin).jour,
      lignes: {
        createMany: {
          data: nouvelles.map((l) => ({
            identifiantPrestataire: l.terminal,
            referenceMonetique: l.reference,
            horodatage: l.horodatage,
            montantCents: l.montantCents,
          })),
        },
      },
    },
  });
  await rapprocher(releve.id);
  return { releve, doublons: lignes.length - nouvelles.length };
}

/** Supprime un relevé : ses ventes redeviennent « non rapprochées ». */
export async function supprimerReleve(id: number) {
  await prisma.$transaction(async (db) => {
    const lignes = await db.releveLigne.findMany({ where: { releveId: id, transactionId: { not: null } }, select: { transactionId: true } });
    await db.transaction.updateMany({ where: { id: { in: lignes.map((l) => l.transactionId!) } }, data: { rapprochement: "NON_RAPPROCHE" } });
    await db.releveMonetique.delete({ where: { id } });
  });
}

const LIMITE_DETAIL = 500;

export type Rapport = Awaited<ReturnType<typeof rapport>>;

/** Synthèse et détail des anomalies d'un relevé (CDC §4 : signaler les écarts). */
export async function rapport(id: number, { complet = false } = {}) {
  const releve = await prisma.releveMonetique.findUnique({ where: { id } });
  if (!releve) throw new HttpError(404, "INTROUVABLE");
  const lignes = await prisma.releveLigne.findMany({
    where: { releveId: id },
    orderBy: { horodatage: "asc" },
    include: { transaction: { select: { id: true, horodatage: true, statut: true, montantTtcCents: true, transactionIdModule: true } } },
  });
  const terminaux = [...new Set(lignes.map((l) => l.identifiantPrestataire))];
  const bornesParTerminal = await bornesDesTerminaux(terminaux);
  const borneIds = [...new Set([...bornesParTerminal.values()].flatMap((s) => [...s]))];
  const bornes = new Map(
    (
      await prisma.borne.findMany({
        where: { id: { in: borneIds } },
        select: { id: true, identifiant: true, affectations: { where: { fin: null }, select: { lieu: { select: { id: true, enseigne: true } } } } },
      })
    ).map((b) => [b.id, { id: b.id, identifiant: b.identifiant, lieu: b.affectations[0]?.lieu ?? null }])
  );

  // Ventes carte de la période sur ces bornes, qu'aucun relevé n'a retrouvées
  const nonEncaissees = await prisma.transaction.findMany({
    where: { ...ventesCarte(borneIds), rapprochement: "NON_RAPPROCHE", jourLocal: { gte: releve.periodeDebut, lte: releve.periodeFin } },
    orderBy: { horodatage: "asc" },
    select: { id: true, borneId: true, horodatage: true, statut: true, montantTtcCents: true, transactionIdModule: true, lieu: { select: { id: true, enseigne: true } } },
  });

  const borneDuTerminal = (t: string) => {
    const ids = bornesParTerminal.get(t);
    return ids ? bornes.get([...ids][0]) ?? null : null;
  };

  type ParTerminal = {
    terminal: string;
    borne: { id: number; identifiant: string; lieu: { id: number; enseigne: string } | null } | null;
    lignes: number; montantCents: number; rapprochees: number; ecarts: number; ecartCents: number;
    nonRemontees: number; nonRemonteesCents: number; nonEncaissees: number; nonEncaisseesCents: number;
  };
  const parTerminal = new Map<string, ParTerminal>();
  const terminal = (t: string) => {
    let p = parTerminal.get(t);
    if (!p) {
      p = { terminal: t, borne: borneDuTerminal(t), lignes: 0, montantCents: 0, rapprochees: 0, ecarts: 0, ecartCents: 0, nonRemontees: 0, nonRemonteesCents: 0, nonEncaissees: 0, nonEncaisseesCents: 0 };
      parTerminal.set(t, p);
    }
    return p;
  };

  const ecarts = [];
  const nonRemontees = [];
  for (const l of lignes) {
    const p = terminal(l.identifiantPrestataire);
    p.lignes++;
    p.montantCents += l.montantCents;
    const base = { id: l.id.toString(), terminal: l.identifiantPrestataire, borne: p.borne, horodatage: l.horodatage, montantCents: l.montantCents, reference: l.referenceMonetique };
    if (l.statut === "RAPPROCHE") p.rapprochees++;
    else if (l.statut === "ECART" && l.transaction) {
      const vente = montantSigne(l.transaction);
      p.ecarts++;
      p.ecartCents += l.montantCents - vente;
      ecarts.push({ ...base, vente: { id: l.transaction.id.toString(), horodatage: l.transaction.horodatage, montantCents: vente, transactionId: l.transaction.transactionIdModule } });
    } else {
      p.nonRemontees++;
      p.nonRemonteesCents += l.montantCents;
      nonRemontees.push(base);
    }
  }
  // Ventes non encaissées, rattachées au terminal de leur borne
  const terminalDeBorne = new Map<number, string>();
  for (const [t, ids] of bornesParTerminal) for (const b of ids) terminalDeBorne.set(b, t);
  const nonEncaisseesDetail = nonEncaissees.map((t) => {
    const p = terminal(terminalDeBorne.get(t.borneId)!);
    p.nonEncaissees++;
    p.nonEncaisseesCents += montantSigne(t);
    return {
      id: t.id.toString(), terminal: p.terminal, borne: bornes.get(t.borneId) ?? null, lieu: t.lieu,
      horodatage: t.horodatage, montantCents: montantSigne(t), transactionId: t.transactionIdModule,
    };
  });

  const terminauxListe = [...parTerminal.values()].sort((a, b) => a.terminal.localeCompare(b.terminal));
  const somme = (f: (p: ParTerminal) => number, filtre: (p: ParTerminal) => boolean = () => true) =>
    terminauxListe.filter(filtre).reduce((s, p) => s + f(p), 0);
  const connu = (p: ParTerminal) => !!p.borne;
  const coupe = <T>(x: T[]) => (complet ? x : x.slice(0, LIMITE_DETAIL));

  return {
    releve: { ...releve, periodeDebut: ymd(releve.periodeDebut), periodeFin: ymd(releve.periodeFin) },
    synthese: {
      lignes: lignes.length,
      montantCents: somme((p) => p.montantCents),
      rapprochees: somme((p) => p.rapprochees),
      ecarts: somme((p) => p.ecarts),
      ecartCents: somme((p) => p.ecartCents),
      nonRemontees: somme((p) => p.nonRemontees, connu),
      nonRemonteesCents: somme((p) => p.nonRemonteesCents, connu),
      nonEncaissees: somme((p) => p.nonEncaissees),
      nonEncaisseesCents: somme((p) => p.nonEncaisseesCents),
      terminauxInconnus: terminauxListe.filter((p) => !connu(p)).map((p) => ({ terminal: p.terminal, lignes: p.lignes, montantCents: p.montantCents })),
    },
    parTerminal: terminauxListe,
    ecarts: coupe(ecarts),
    nonRemontees: coupe(nonRemontees.filter((l) => l.borne)),
    nonEncaissees: coupe(nonEncaisseesDetail),
    tronque: !complet && Math.max(ecarts.length, nonRemontees.length, nonEncaisseesDetail.length) > LIMITE_DETAIL,
  };
}

/** Alerte ECART_RAPPROCHEMENT par borne dont les anomalies dépassent le seuil. */
export async function alerterEcarts(r: Rapport, maintenant = new Date()) {
  const regle = await chargerRegles();
  const creees = [];
  for (const p of r.parTerminal) {
    if (!p.borne) continue;
    const lieuId = p.borne.lieu?.id;
    const reg = regle("ECART_RAPPROCHEMENT", lieuId);
    const total = Math.abs(p.nonRemonteesCents) + Math.abs(p.nonEncaisseesCents) + Math.abs(p.ecartCents);
    if (!reg.actif || total < reg.parametres.seuilEuros * 100) continue;
    const details = [
      p.nonRemontees && `${p.nonRemontees} paiement(s) encaissé(s) non remonté(s) (${eur(p.nonRemonteesCents)})`,
      p.nonEncaissees && `${p.nonEncaissees} vente(s) remontée(s) non encaissée(s) (${eur(p.nonEncaisseesCents)})`,
      p.ecarts && `${p.ecarts} écart(s) de montant (${eur(p.ecartCents)})`,
    ].filter(Boolean);
    const a = await lever(
      {
        type: "ECART_RAPPROCHEMENT",
        niveau: reg.niveau,
        borneId: p.borne.id,
        lieuId,
        message: `Relevé ${r.releve.fournisseur} du ${r.releve.periodeDebut} au ${r.releve.periodeFin}, ${p.borne.identifiant} : ${details.join(", ")}`,
        valeurs: { releveId: r.releve.id, terminal: p.terminal, totalCents: total, seuilEuros: reg.parametres.seuilEuros },
      },
      maintenant
    );
    if (a) creees.push(a);
  }
  if (creees.length) await notifierAlertes(creees).catch((err) => console.error("Notification des écarts de rapprochement :", err));
  return creees;
}
