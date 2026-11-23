import { Prisma, type CarteLieu, type EffetCarteLieu, type UtilisationCarteLieu } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { lieuActuel } from "../codes/codes.js";

// Cartes sans contact du lieu (Mifare), avenant du 23/11/2026 (docs/avenant-cartes-lieu.md). La borne rend l'UID lu
// par le terminal ; la Régie décide tout : carte connue, lieu, validité, plafond du jour, solde. Refus par défaut :
// sans réponse de la Régie, la borne refuse la carte.

export type RaisonRefusCarte = "INCONNUE" | "DESACTIVEE" | "EXPIREE" | "LIEU" | "PLAFOND" | "SOLDE_INSUFFISANT" | "ANNULEE";

export const MESSAGES_REFUS_CARTE: Record<RaisonRefusCarte, string> = {
  INCONNUE: "Carte inconnue",
  DESACTIVEE: "Carte désactivée",
  EXPIREE: "Carte expirée",
  LIEU: "Carte d'un autre lieu",
  PLAFOND: "Plafond du jour atteint",
  SOLDE_INSUFFISANT: "Solde insuffisant",
  ANNULEE: "Utilisation annulée par la borne",
};

/** UID tel que le terminal le rend : hexadécimal, 4, 7 ou 10 octets. Ramené en majuscules ; null s'il est mal formé. */
export function normaliserUid(v: string): string | null {
  const u = v.trim().toUpperCase().replace(/[\s:-]/g, "");
  return /^[0-9A-F]{8}$|^[0-9A-F]{14}$|^[0-9A-F]{20}$/.test(u) ? u : null;
}

/** Les 4 derniers caractères d'un UID (journal, écrans où l'UID complet n'est pas utile) */
export const finUid = (uid: string) => `…${uid.slice(-4)}`;

type CarteDecision = Pick<CarteLieu, "lieuId" | "effet" | "soldeCents" | "plafondJourCents" | "plafondJourTirages" | "expireLe" | "desactiveLe">;

export type Decision = { ok: true; effet: EffetCarteLieu; debitCents: number } | { ok: false; raison: RaisonRefusCarte };

/**
 * Décision pour une présentation de carte. `dejaJour` : ce que la carte a déjà servi aujourd'hui (heure de Paris),
 * utilisations acceptées et non annulées. Pas de débit partiel : un solde trop court est un refus.
 */
export function deciderCarte(
  carte: CarteDecision | null,
  c: { lieuBorne: number | null; montantCents: number; nb: number; dejaJour: { cents: number; tirages: number }; maintenant?: Date }
): Decision {
  if (!carte) return { ok: false, raison: "INCONNUE" };
  if (carte.desactiveLe) return { ok: false, raison: "DESACTIVEE" };
  if (carte.expireLe && jourEtHeureLocaux(c.maintenant ?? new Date()).jour.getTime() > carte.expireLe.getTime()) return { ok: false, raison: "EXPIREE" };
  // Borne en stock (aucun lieu) ou installée ailleurs
  if (carte.lieuId !== c.lieuBorne) return { ok: false, raison: "LIEU" };
  if (carte.effet === "OFFERT") {
    if (carte.plafondJourTirages != null && c.dejaJour.tirages + c.nb > carte.plafondJourTirages) return { ok: false, raison: "PLAFOND" };
    return { ok: true, effet: "OFFERT", debitCents: 0 };
  }
  if (carte.plafondJourCents != null && c.dejaJour.cents + c.montantCents > carte.plafondJourCents) return { ok: false, raison: "PLAFOND" };
  if (carte.soldeCents < c.montantCents) return { ok: false, raison: "SOLDE_INSUFFISANT" };
  return { ok: true, effet: "DEBITE", debitCents: c.montantCents };
}

type UtilisationReponse = Pick<UtilisationCarteLieu, "accepte" | "effet" | "montantDebiteCents" | "soldeApresCents" | "raison" | "annuleeLe">;

/**
 * Réponse à la borne pour une utilisation enregistrée : la même au premier appel et à un renvoi (même utilisation_id).
 * Une utilisation déjà annulée par la borne n'est plus jamais rendue acceptée : rien ne doit être servi après coup.
 */
export function reponseUtilisation(u: UtilisationReponse, libelle: string | null) {
  if (u.accepte && !u.annuleeLe) {
    return {
      ok: true as const,
      effet: u.effet === "OFFERT" ? ("offert" as const) : ("debite" as const),
      ...(u.effet === "DEBITE" ? { montant_debite_centimes: u.montantDebiteCents, solde_restant_centimes: u.soldeApresCents ?? 0 } : {}),
      ...(libelle ? { libelle } : {}),
    };
  }
  const raison = (u.annuleeLe ? "ANNULEE" : (u.raison ?? "INCONNUE")) as RaisonRefusCarte;
  return { ok: false as const, raison, message: MESSAGES_REFUS_CARTE[raison] ?? "Carte non acceptée" };
}

export interface DemandeUtilisation {
  uid: string;
  typeCarte: string | null;
  montantCents: number;
  nb: number;
  utilisationId: string;
  sessionCode: string | null;
  evenementCode: string | null;
}

const estDoublon = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Une utilisation déjà enregistrée pour cette borne, avec le libellé actuel de sa carte */
async function rejouer(borneId: number, utilisationId: string) {
  const u = await prisma.utilisationCarteLieu.findUnique({
    where: { borneId_utilisationId: { borneId, utilisationId } },
    include: { carte: { select: { libelle: true } } },
  });
  return u ? reponseUtilisation(u, u.carte?.libelle ?? null) : null;
}

/**
 * POST ingest/v1/cartes/utiliser : vérifie la carte et l'utilise dans le même appel. La carte est verrouillée le temps
 * du débit (deux bornes en même temps ne dépassent ni le solde ni le plafond) ; un renvoi du même utilisation_id rend
 * la première réponse sans rien débiter.
 */
export async function utiliserCarte(borneId: number, d: DemandeUtilisation, maintenant = new Date()) {
  const premiere = await rejouer(borneId, d.utilisationId);
  if (premiere) return premiere;
  const lieuBorne = await lieuActuel(borneId, maintenant);
  try {
    return await prisma.$transaction(async (db) => {
      const [verrou] = await db.$queryRaw<{ id: number }[]>`SELECT id FROM cartes_lieu WHERE uid = ${d.uid} FOR UPDATE`;
      const carte = verrou ? await db.carteLieu.findUnique({ where: { id: verrou.id } }) : null;
      // Même utilisation arrivée pendant l'attente du verrou (renvoi de la borne) : la première réponse
      const deja = await db.utilisationCarteLieu.findUnique({ where: { borneId_utilisationId: { borneId, utilisationId: d.utilisationId } } });
      if (deja) return reponseUtilisation(deja, carte?.libelle ?? null);

      let dejaJour = { cents: 0, tirages: 0 };
      if (carte && (carte.plafondJourCents != null || carte.plafondJourTirages != null)) {
        const jour = jourEtHeureLocaux(maintenant).jour.toISOString().slice(0, 10);
        const [s] = await db.$queryRaw<{ cents: bigint | null; tirages: bigint | null }[]>`
          SELECT sum(montant_debite_cents) cents, sum(nb) tirages FROM utilisations_carte_lieu
          WHERE carte_id = ${carte.id} AND accepte AND annulee_le IS NULL
            AND (horodatage AT TIME ZONE 'Europe/Paris')::date = ${jour}::date`;
        dejaJour = { cents: Number(s?.cents ?? 0), tirages: Number(s?.tirages ?? 0) };
      }

      const decision = deciderCarte(carte, { lieuBorne, montantCents: d.montantCents, nb: d.nb, dejaJour, maintenant });
      let soldeApres: number | null = carte?.effet === "DEBITE" ? carte.soldeCents : null;
      if (decision.ok && decision.debitCents > 0) {
        const maj = await db.carteLieu.update({ where: { id: carte!.id }, data: { soldeCents: { decrement: decision.debitCents } }, select: { soldeCents: true } });
        soldeApres = maj.soldeCents;
      }
      const u = await db.utilisationCarteLieu.create({
        data: {
          carteId: carte?.id ?? null,
          uid: d.uid,
          typeCarte: d.typeCarte,
          borneId,
          lieuId: lieuBorne,
          utilisationId: d.utilisationId,
          montantCents: d.montantCents,
          nb: d.nb,
          sessionCode: d.sessionCode,
          evenementCode: d.evenementCode,
          accepte: decision.ok,
          effet: decision.ok ? decision.effet : null,
          montantDebiteCents: decision.ok ? decision.debitCents : 0,
          soldeApresCents: soldeApres,
          raison: decision.ok ? null : decision.raison,
          horodatage: maintenant,
        },
      });
      return reponseUtilisation(u, carte?.libelle ?? null);
    });
  } catch (e) {
    // Carte inconnue (pas de verrou) ou annulation arrivée entre-temps : la ligne existe, sa réponse fait foi
    if (estDoublon(e)) {
      const r = await rejouer(borneId, d.utilisationId);
      if (r) return r;
    }
    throw e;
  }
}

export type RaisonAnnulation = "tirage_non_sorti" | "sans_reponse" | "reponse_tardive";

/**
 * POST ingest/v1/cartes/annuler : rend le montant débité à la carte. Idempotente : une utilisation inconnue ou déjà
 * annulée répond annulee à false. Une annulation qui arrive avant son utilisation (réponse perdue, requête encore en
 * route) laisse une ligne « annulée » : l'utilisation qui arriverait ensuite est refusée sans rien débiter.
 */
export async function annulerUtilisation(borneId: number, utilisationId: string, raison: RaisonAnnulation, maintenant = new Date()): Promise<{ ok: true; annulee: boolean }> {
  for (let essai = 0; essai < 2; essai++) {
    try {
      return await prisma.$transaction(async (db) => {
        const [ligne] = await db.$queryRaw<{ id: bigint }[]>`
          SELECT id FROM utilisations_carte_lieu WHERE borne_id = ${borneId} AND utilisation_id = ${utilisationId} FOR UPDATE`;
        if (!ligne) {
          await db.utilisationCarteLieu.create({
            data: { borneId, utilisationId, montantCents: 0, nb: 0, accepte: false, raison: "ANNULEE", annuleeLe: maintenant, annulationRaison: raison, horodatage: maintenant },
          });
          return { ok: true as const, annulee: false };
        }
        const u = await db.utilisationCarteLieu.findUniqueOrThrow({ where: { id: ligne.id } });
        if (u.annuleeLe || !u.accepte) return { ok: true as const, annulee: false };
        if (u.carteId && u.montantDebiteCents > 0) {
          await db.$queryRaw`SELECT id FROM cartes_lieu WHERE id = ${u.carteId} FOR UPDATE`;
          await db.carteLieu.update({ where: { id: u.carteId }, data: { soldeCents: { increment: u.montantDebiteCents } } });
        }
        await db.utilisationCarteLieu.update({ where: { id: u.id }, data: { annuleeLe: maintenant, annulationRaison: raison } });
        return { ok: true as const, annulee: true };
      });
    } catch (e) {
      // L'utilisation a été créée pendant qu'on posait la ligne d'annulation : on recommence, elle sera annulée
      if (!estDoublon(e) || essai > 0) throw e;
    }
  }
  return { ok: true, annulee: false };
}
