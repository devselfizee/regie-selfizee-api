import { Prisma, type Alerte, type NiveauAlerte, type TypeAlerte } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { chargerRegles } from "./regles.js";
import { jourOuvert, joursOuverts, localParis, ouvertA, type OuvertureLieu } from "./ouverture.js";

const HEURE = 3_600_000;
const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const eur = (c: number) => `${(c / 100).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} €`;
const dateHeure = (d: Date) =>
  new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);

interface NouvelleAlerte {
  type: TypeAlerte;
  niveau: NiveauAlerte;
  lieuId?: number;
  borneId?: number;
  message: string;
  valeurs: Record<string, unknown>;
}

const OUVERTES = ["NOUVELLE", "PRISE_EN_CHARGE"] as const;

/**
 * Crée l'alerte sauf si la même anomalie est déjà ouverte (ou a déjà été
 * relevée aujourd'hui : une alerte ignorée ne revient pas avant demain).
 */
async function lever(a: NouvelleAlerte, maintenant: Date): Promise<Alerte | null> {
  const cible = { type: a.type, lieuId: a.lieuId ?? null, borneId: a.borneId ?? null };
  if (await prisma.alerte.findFirst({ where: { ...cible, statut: { in: [...OUVERTES] } } })) return null;
  try {
    return await prisma.alerte.create({
      data: {
        ...cible,
        niveau: a.niveau,
        message: a.message,
        valeurs: a.valeurs as Prisma.InputJsonValue,
        detecteeLe: maintenant,
        cleDedup: `${a.type}:${a.borneId ?? ""}:${a.lieuId ?? ""}:${ymd(localParis(maintenant).jour)}`,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}

/** Résolution automatique quand l'anomalie a disparu. */
async function resoudre(type: TypeAlerte, cible: { lieuId?: number; borneId?: number }, commentaire: string, maintenant: Date) {
  const { count } = await prisma.alerte.updateMany({
    where: { type, ...cible, statut: { in: [...OUVERTES] } },
    data: { statut: "RESOLUE", resolueLe: maintenant, commentaire },
  });
  return count;
}

async function caParJour(lieuId: number, du: Date, au: Date): Promise<number> {
  const r = await prisma.aggJour.aggregate({ where: { lieuId, jour: { gte: du, lte: au } }, _sum: { caTtcCents: true } });
  return r._sum.caTtcCents ?? 0;
}

/**
 * Évalue toutes les règles d'alerte à l'instant donné. Idempotent : peut tourner
 * toutes les quinze minutes. Renvoie les alertes créées (à notifier).
 */
export async function evaluerAlertes(maintenant = new Date()) {
  const regle = await chargerRegles();
  const creees: Alerte[] = [];
  let resolues = 0;
  const ajouter = (a: Alerte | null) => a && creees.push(a);

  const lieux = await prisma.lieu.findMany({
    where: { statut: "ACTIF" },
    include: {
      horaires: true,
      saisons: true,
      fermetures: true,
      affectations: {
        where: { debut: { lte: maintenant }, OR: [{ fin: null }, { fin: { gt: maintenant } }] },
        include: { borne: true },
      },
    },
  });

  const hier = new Date(localParis(maintenant).jour.getTime() - JOUR);

  for (const lieu of lieux) {
    const o: OuvertureLieu = lieu;
    const bornes = lieu.affectations.map((a) => ({ ...a.borne, installeeLe: a.debut })).filter((b) => b.statut !== "REFORMEE");
    if (!bornes.length) continue;
    const nom = lieu.enseigne;

    // ─── Borne muette ───
    const rMuette = regle("BORNE_MUETTE", lieu.id);
    const muettes = new Set<number>();
    for (const b of bornes) {
      const limite = new Date(maintenant.getTime() - rMuette.parametres.heures * HEURE);
      const silencieuse = b.dernierHeartbeat ? b.dernierHeartbeat < limite : b.installeeLe < limite;
      if (!silencieuse) {
        resolues += await resoudre("BORNE_MUETTE", { borneId: b.id }, "Résolue automatiquement : la borne a redonné signe de vie", maintenant);
        continue;
      }
      muettes.add(b.id);
      // Le lieu doit être ouvert maintenant et depuis la durée de la règle (pas d'alerte à l'ouverture)
      if (rMuette.actif && ouvertA(o, maintenant) && ouvertA(o, limite)) {
        ajouter(
          await lever(
            {
              type: "BORNE_MUETTE", niveau: rMuette.niveau, lieuId: lieu.id, borneId: b.id,
              message: b.dernierHeartbeat
                ? `${b.identifiant} (${nom}) ne donne plus signe de vie depuis le ${dateHeure(b.dernierHeartbeat)}`
                : `${b.identifiant} (${nom}) ne s'est jamais connectée depuis son installation`,
              valeurs: { dernierHeartbeat: b.dernierHeartbeat, heures: rMuette.parametres.heures },
            },
            maintenant
          )
        );
      }
    }

    // ─── Consommables (dernier heartbeat de chaque borne) ───
    const rConso = regle("CONSOMMABLES", lieu.id);
    for (const b of bornes) {
      const hb = await prisma.heartbeat.findFirst({ where: { borneId: b.id }, orderBy: { horodatage: "desc" } });
      const restes = [hb?.papierRestant, hb?.rubanRestant].filter((v): v is number => v !== null && v !== undefined);
      if (!restes.length) continue;
      const reste = Math.min(...restes);
      if (reste >= rConso.parametres.seuilTirages) {
        resolues += await resoudre("CONSOMMABLES", { borneId: b.id }, "Résolue automatiquement : consommables rechargés", maintenant);
      } else if (rConso.actif) {
        ajouter(
          await lever(
            {
              type: "CONSOMMABLES", niveau: rConso.niveau, lieuId: lieu.id, borneId: b.id,
              message: `${b.identifiant} (${nom}) : plus que ${reste} tirages (${hb!.papierRestant ?? "?"} papier, ${hb!.rubanRestant ?? "?"} ruban)`,
              valeurs: { papierRestant: hb!.papierRestant, rubanRestant: hb!.rubanRestant, seuil: rConso.parametres.seuilTirages },
            },
            maintenant
          )
        );
      }
    }

    // ─── Zéro vente inhabituel ───
    const rZero = regle("ZERO_VENTE", lieu.id);
    const debutFenetre = new Date(maintenant.getTime() - rZero.parametres.heures * HEURE);
    const ventesRecentes = await prisma.transaction.count({
      where: { lieuId: lieu.id, statut: "ACCEPTEE", horodatage: { gte: debutFenetre, lte: maintenant } },
    });
    if (ventesRecentes > 0) {
      resolues += await resoudre("ZERO_VENTE", { lieuId: lieu.id }, "Résolue automatiquement : les ventes ont repris", maintenant);
    } else if (rZero.actif && muettes.size < bornes.length && ouvertA(o, maintenant) && ouvertA(o, debutFenetre)) {
      // Même créneau, même jour de semaine, sur les 4 semaines précédentes
      let habituel = 0;
      for (let k = 1; k <= 4; k++) {
        habituel += await prisma.transaction.count({
          where: {
            lieuId: lieu.id,
            statut: "ACCEPTEE",
            horodatage: { gte: new Date(debutFenetre.getTime() - k * 7 * JOUR), lt: new Date(maintenant.getTime() - k * 7 * JOUR) },
          },
        });
      }
      const moyenne = habituel / 4;
      if (moyenne >= rZero.parametres.minVentesAttendues) {
        ajouter(
          await lever(
            {
              type: "ZERO_VENTE", niveau: rZero.niveau, lieuId: lieu.id,
              message: `${nom} : aucune vente depuis ${rZero.parametres.heures} h, contre ${moyenne.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} en moyenne sur ce créneau`,
              valeurs: { heures: rZero.parametres.heures, moyenneHabituelle: moyenne },
            },
            maintenant
          )
        );
      }
    }

    // ─── Taux de refus sur 24 h ───
    const rRefus = regle("TAUX_REFUS", lieu.id);
    if (rRefus.actif) {
      const depuis = new Date(maintenant.getTime() - 24 * HEURE);
      const parStatut = await prisma.transaction.groupBy({
        by: ["statut"],
        where: { lieuId: lieu.id, horodatage: { gte: depuis, lte: maintenant }, statut: { in: ["ACCEPTEE", "REFUSEE"] } },
        _count: true,
      });
      const refus = parStatut.find((s) => s.statut === "REFUSEE")?._count ?? 0;
      const total = parStatut.reduce((s, x) => s + x._count, 0);
      if (total >= rRefus.parametres.minTentatives && (refus / total) * 100 > rRefus.parametres.seuilPct) {
        ajouter(
          await lever(
            {
              type: "TAUX_REFUS", niveau: rRefus.niveau, lieuId: lieu.id,
              message: `${nom} : ${Math.round((refus / total) * 100)} % de paiements refusés sur 24 h (${refus} sur ${total})`,
              valeurs: { refus, total, seuilPct: rRefus.parametres.seuilPct },
            },
            maintenant
          )
        );
      }
    }

    // ─── Baisse de CA (jours ouverts, jusqu'à hier) ───
    const rBaisse = regle("BAISSE_CA", lieu.id);
    if (rBaisse.actif) {
      const p = rBaisse.parametres;
      const finF = hier;
      const debutF = new Date(finF.getTime() - (p.fenetreJours - 1) * JOUR);
      const finR = new Date(debutF.getTime() - JOUR);
      const debutR = new Date(finR.getTime() - (p.referenceJours - 1) * JOUR);
      const joF = joursOuverts(o, debutF, finF);
      const joR = joursOuverts(o, debutR, finR);
      if (joF >= 3 && joR >= 7) {
        const moyF = (await caParJour(lieu.id, debutF, finF)) / joF;
        const moyR = (await caParJour(lieu.id, debutR, finR)) / joR;
        const ratio = moyR ? (moyF / moyR) * 100 : 100;
        if (moyR >= p.minCaJourReferenceEuros * 100 && ratio < p.seuilPct) {
          ajouter(
            await lever(
              {
                type: "BAISSE_CA",
                niveau: ratio < p.seuilCritiquePct ? "CRITIQUE" : rBaisse.niveau,
                lieuId: lieu.id,
                message: `${nom} : ${eur(moyF)} par jour ouvert sur ${p.fenetreJours} jours, contre ${eur(moyR)} avant (${Math.round(ratio)} %)`,
                valeurs: { moyenneFenetreCents: Math.round(moyF), moyenneReferenceCents: Math.round(moyR), ratioPct: Math.round(ratio) },
              },
              maintenant
            )
          );
        }
      }
    }

    // ─── Pic suspect (hier) ───
    const rPic = regle("PIC_SUSPECT", lieu.id);
    if (rPic.actif) {
      const caHier = await caParJour(lieu.id, hier, hier);
      const debutR = new Date(hier.getTime() - 28 * JOUR);
      const finR = new Date(hier.getTime() - JOUR);
      const joR = joursOuverts(o, debutR, finR);
      const moyR = joR >= 7 ? (await caParJour(lieu.id, debutR, finR)) / joR : 0;
      if (moyR > 0 && caHier >= rPic.parametres.minCaEuros * 100 && caHier > rPic.parametres.facteur * moyR) {
        ajouter(
          await lever(
            {
              type: "PIC_SUSPECT", niveau: rPic.niveau, lieuId: lieu.id,
              message: `${nom} : ${eur(caHier)} le ${ymd(hier).split("-").reverse().join("/")}, soit ${(caHier / moyR).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} fois la moyenne (${eur(moyR)}) — à vérifier (doublon, fraude, événement ?)`,
              valeurs: { caCents: caHier, moyenneCents: Math.round(moyR) },
            },
            maintenant
          )
        );
      }
    }

    // ─── Ventes hors horaires (hier, si les horaires sont renseignés) ───
    const rHors = regle("VENTE_HORS_HORAIRES", lieu.id);
    if (rHors.actif && lieu.horaires.length) {
      const ventes = await prisma.transaction.findMany({
        where: { lieuId: lieu.id, statut: "ACCEPTEE", jourLocal: hier },
        select: { horodatage: true },
      });
      const hors = ventes.filter((v) => !ouvertA(o, v.horodatage));
      if (hors.length >= rHors.parametres.minVentes) {
        ajouter(
          await lever(
            {
              type: "VENTE_HORS_HORAIRES", niveau: rHors.niveau, lieuId: lieu.id,
              message: `${nom} : ${hors.length} ventes le ${ymd(hier).split("-").reverse().join("/")} en dehors des horaires de la fiche (${hors
                .slice(0, 3)
                .map((v) => dateHeure(v.horodatage).slice(-5))
                .join(", ")}${hors.length > 3 ? "…" : ""}) — fiche à corriger ou usage anormal`,
              valeurs: { nombre: hors.length, jourFerme: !jourOuvert(o, hier) },
            },
            maintenant
          )
        );
      }
    }
  }

  return { creees, resolues };
}
