import { Router } from "express";
import { TZDate } from "@date-fns/tz";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import { FUSEAU_METIER } from "../lib/temps.js";
import { localParis, ouvertA, prochaineOuverture } from "../alertes/ouverture.js";

// Supervision en direct (demandes de Sébastien, 02/11/2026) : monitoring live des bornes et état du papier.
// Une borne « devrait être allumée » quand son lieu est ouvert (horaires, saison, fermetures de la fiche).
export const supervisionRouter = Router();

// En ligne : signe de vie depuis moins de 15 minutes (la borne en envoie toutes les 5 minutes)
const EN_LIGNE_MS = 15 * 60_000;
// La soirée commence à 6 h : une soirée de 22 h à 5 h reste une seule journée d'exploitation
const HEURE_DEBUT_JOURNEE = 6;

/** Début de la journée d'exploitation en cours (6 h, heure de Paris) */
export function debutJournee(maintenant = new Date()): Date {
  const { jour, minutes } = localParis(maintenant);
  const j = minutes < HEURE_DEBUT_JOURNEE * 60 ? new Date(jour.getTime() - 86_400_000) : jour;
  return new Date(new TZDate(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate(), HEURE_DEBUT_JOURNEE, 0, FUSEAU_METIER).getTime());
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
type Erreur = { code: string; message?: string; composant?: string };

// GET /api/supervision — toutes les bornes en service : connexion, lieu ouvert ou non, papier, terminal, soirée en cours
supervisionRouter.get(
  "/",
  asynchrone(async (_req, res) => {
    const maintenant = new Date();
    const debut = debutJournee(maintenant);
    const bornes = await prisma.borne.findMany({
      where: { statut: { not: "REFORMEE" } },
      select: {
        id: true,
        identifiant: true,
        dernierHeartbeat: true,
        derniereVente: true,
        logicielVersion: true,
        gamme: { select: { libelle: true } },
        affectations: {
          where: { debut: { lte: maintenant }, OR: [{ fin: null }, { fin: { gt: maintenant } }] },
          take: 1,
          select: {
            lieu: {
              select: {
                id: true, enseigne: true, ville: true, papierSurPlace: true, saisonnalite: true,
                horaires: { select: { jourSemaine: true, ouverture: true, fermeture: true } },
                saisons: { select: { debut: true, fin: true } },
                fermetures: { select: { debut: true, fin: true } },
              },
            },
          },
        },
      },
      orderBy: { identifiant: "asc" },
    });
    const ids = bornes.map((b) => b.id);
    if (!ids.length) return res.json({ maintenant, debutJournee: debut, bornes: [] });

    const [hb, papiers, ventes, seances, photos] = await Promise.all([
      // Dernier signe de vie (état de l'imprimante et du terminal, erreurs)
      prisma.$queryRaw<{ borne_id: number; horodatage: Date; imprimante_ok: boolean | null; module_paiement_ok: boolean | null; erreurs: Erreur[] | null; logiciel_version: string | null }[]>`
        SELECT DISTINCT ON (borne_id) borne_id, horodatage, imprimante_ok, module_paiement_ok, erreurs, logiciel_version
        FROM heartbeats WHERE borne_id = ANY(${ids}::int[]) ORDER BY borne_id, horodatage DESC`,
      // Dernier niveau de papier connu, et de quand il date
      prisma.$queryRaw<{ borne_id: number; horodatage: Date; papier_restant: number; ruban_restant: number | null }[]>`
        SELECT DISTINCT ON (borne_id) borne_id, horodatage, papier_restant, ruban_restant
        FROM heartbeats WHERE borne_id = ANY(${ids}::int[]) AND papier_restant IS NOT NULL ORDER BY borne_id, horodatage DESC`,
      // Ventes de la journée (vraies ventes, hors cartes de test)
      prisma.$queryRaw<({ borne_id: number } & Record<string, unknown>)[]>`
        SELECT borne_id, count(*) FILTER (WHERE statut = 'ACCEPTEE' AND montant_ttc_cents > 0 AND moyen_paiement <> 'AUCUN') nb,
               coalesce(sum(montant_ttc_cents) FILTER (WHERE statut = 'ACCEPTEE' AND montant_ttc_cents > 0 AND moyen_paiement <> 'AUCUN'), 0) ca,
               count(*) FILTER (WHERE statut IN ('REFUSEE', 'ANNULEE', 'EXPIREE')) echecs
        FROM transactions WHERE borne_id = ANY(${ids}::int[]) AND horodatage >= ${debut} AND NOT test GROUP BY borne_id`,
      // Séances de la journée (parcours invité)
      prisma.$queryRaw<({ borne_id: number } & Record<string, unknown>)[]>`
        SELECT DISTINCT ON (borne_id) borne_id, fin derniere_fin, issue derniere_issue,
               count(*) OVER (PARTITION BY borne_id) nb,
               sum(photos) OVER (PARTITION BY borne_id) photos,
               sum(tirages) OVER (PARTITION BY borne_id) tirages
        FROM parcours WHERE borne_id = ANY(${ids}::int[]) AND debut >= ${debut} ORDER BY borne_id, fin DESC`,
      // Dernière photo prise (30 derniers jours)
      prisma.$queryRaw<{ borne_id: number; derniere: Date | null }[]>`
        SELECT borne_id, max((etapes ->> 'photo')::timestamptz) derniere
        FROM parcours WHERE borne_id = ANY(${ids}::int[]) AND debut >= ${new Date(maintenant.getTime() - 30 * 86_400_000)} GROUP BY borne_id`,
    ]);
    const par = <T extends { borne_id: unknown }>(l: T[]) => new Map(l.map((x) => [n(x.borne_id), x]));
    const [mHb, mPapier, mVentes, mSeances, mPhotos] = [par(hb), par(papiers), par(ventes), par(seances), par(photos)];

    res.json({
      maintenant,
      debutJournee: debut,
      bornes: bornes.map((b) => {
        const lieu = b.affectations[0]?.lieu ?? null;
        const h = mHb.get(b.id);
        const p = mPapier.get(b.id);
        const v = mVentes.get(b.id);
        const s = mSeances.get(b.id);
        const enLigne = !!b.dernierHeartbeat && maintenant.getTime() - b.dernierHeartbeat.getTime() < EN_LIGNE_MS;
        const ouvert = lieu ? ouvertA(lieu, maintenant) : false;
        const erreurs = (h?.erreurs ?? []) as Erreur[];
        const probleme = h?.imprimante_ok === false || h?.module_paiement_ok === false || erreurs.length > 0;
        return {
          borneId: b.id,
          identifiant: b.identifiant,
          gamme: b.gamme.libelle,
          // papierSurPlace : le lieu change lui-même le papier (sinon Selfizee)
          lieu: lieu && { id: lieu.id, enseigne: lieu.enseigne, ville: lieu.ville, papierSurPlace: lieu.papierSurPlace },
          enLigne,
          lieuOuvert: ouvert,
          prochaineOuverture: lieu ? prochaineOuverture(lieu, maintenant) : null,
          // ok : en ligne sans souci ; alerte : en ligne avec une erreur ; eteinte_anormale : lieu ouvert et pas de signal ; eteinte : lieu fermé
          etat: enLigne ? (probleme ? "alerte" : "ok") : ouvert ? "eteinte_anormale" : "eteinte",
          dernierPing: b.dernierHeartbeat,
          derniereVente: b.derniereVente,
          dernierePhoto: mPhotos.get(b.id)?.derniere ?? null,
          logicielVersion: h?.logiciel_version ?? b.logicielVersion,
          imprimanteOk: h?.imprimante_ok ?? null,
          terminalOk: h?.module_paiement_ok ?? null,
          etatLe: h?.horodatage ?? null,
          erreurs,
          papier: p ? { restant: p.papier_restant, ruban: p.ruban_restant, le: p.horodatage } : null,
          journee: {
            ventes: n(v?.nb),
            caTtcCents: n(v?.ca),
            echecs: n(v?.echecs),
            seances: n(s?.nb),
            photos: n(s?.photos),
            tirages: n(s?.tirages),
            derniereSeance: s ? { fin: s.derniere_fin as Date, issue: s.derniere_issue as string } : null,
          },
        };
      }),
    });
  })
);
