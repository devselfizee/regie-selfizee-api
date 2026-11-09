import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import { perimetreLieux, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { aujourdhui, moisDe, previsionCommission, previsionMois, prevoirLieux, resume } from "../previsions/service.js";
import { userCan } from "../middleware/permissions.js";

// Prévisions de CA (CDC V3 « pilotage »)
export const previsionsRouter = Router();

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Part HT du CA TTC des 90 derniers jours (TVA réelle des ventes) : les prévisions sont calculées en TTC,
 * l'écran les passe en HT avec ce ratio quand on bascule sur HT (retour de Sébastien). 1/1,2 sans historique.
 */
async function partHt(lieuIds: number[]): Promise<number> {
  if (!lieuIds.length) return 1 / 1.2;
  const s = await prisma.aggJour.aggregate({
    where: { lieuId: { in: lieuIds }, jour: { gte: new Date(aujourdhui().getTime() - 90 * 86_400_000) } },
    _sum: { caTtcCents: true, caHtCents: true },
  });
  const ttc = s._sum.caTtcCents ?? 0;
  return ttc > 0 ? (s._sum.caHtCents ?? 0) / ttc : 1 / 1.2;
}

// GET /api/previsions/lieux/:id — mois en cours jour par jour, et période de commission en cours
previsionsRouter.get(
  "/lieux/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    // Commission : mêmes droits que la fiche commissions (le commercial ne la voit pas)
    const voitCommission = await userCan(req, "commissions.view");
    // Pas de projection avant une semaine d'activité (retour de Sébastien) : trop peu de jours pour prévoir
    const premiere = (await prisma.aggJour.aggregate({ where: { lieuId, nbAcceptees: { gt: 0 } }, _min: { jour: true } }))._min.jour;
    if (!premiere || aujourdhui().getTime() - premiere.getTime() < 7 * 86_400_000) {
      res.json({ mois: null, commission: null, premiereVente: premiere ? ymd(premiere) : null });
      return;
    }
    const [mois, commission, ratioHt] = await Promise.all([previsionMois(lieuId), voitCommission ? previsionCommission(lieuId) : null, partHt([lieuId])]);
    res.json({ mois, commission, ratioHt });
  })
);

// GET /api/previsions/global — mois en cours, tous les lieux actifs du périmètre
previsionsRouter.get(
  "/global",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const jour = aujourdhui();
    const { du, au } = moisDe(jour);
    const p = perimetreLieux(req.utilisateur);
    const lieux = await prisma.lieu.findMany({
      where: { statut: "ACTIF", ...(p?.commercialId ? { commercialId: p.commercialId } : {}), ...(p?.lieuId !== undefined ? { id: p.lieuId } : {}) },
      select: { id: true, enseigne: true, ville: true, codePostal: true, saisonnalite: true, horaires: true, saisons: true, fermetures: true },
    });
    const previsions = await prevoirLieux(lieux, du, au, jour);

    // Même mois l'an dernier et mois précédent, pour situer la prévision
    const n1 = moisDe(new Date(Date.UTC(du.getUTCFullYear() - 1, du.getUTCMonth(), 1)));
    const prec = moisDe(new Date(Date.UTC(du.getUTCFullYear(), du.getUTCMonth() - 1, 1)));
    const ids = lieux.map((l) => l.id);
    const ca = async (a: Date, b: Date) =>
      ids.length
        ? (await prisma.aggJour.aggregate({ where: { lieuId: { in: ids }, jour: { gte: a, lte: b } }, _sum: { caTtcCents: true } }))._sum.caTtcCents ?? 0
        : 0;
    const [n1Cents, precedentCents, ratioHt] = await Promise.all([ca(n1.du, n1.au), ca(prec.du, prec.au), partHt(ids)]);

    const tous = [...previsions.values()];
    const somme = (f: (x: (typeof tous)[number]) => number) => tous.reduce((s, x) => s + f(x), 0);
    // Les incertitudes des lieux s'additionnent quadratiquement (lieux indépendants)
    const ecart = Math.sqrt(somme((x) => (x.hauteCents - x.totalCents) ** 2));
    const total = somme((x) => x.totalCents);
    const jours = (tous[0]?.jours ?? []).map((j, i) => ({
      jour: j.jour,
      realiseCents: j.realiseCents === null ? null : somme((x) => x.jours[i].realiseCents ?? 0),
      prevuCents: somme((x) => x.jours[i].prevuCents),
    }));

    res.json({
      du: ymd(du),
      au: ymd(au),
      realiseCents: somme((x) => x.realiseCents),
      restantCents: somme((x) => x.restantCents),
      totalCents: total,
      basseCents: Math.round(Math.max(somme((x) => x.realiseCents), total - ecart)),
      hauteCents: Math.round(total + ecart),
      n1Cents,
      precedentCents,
      ratioHt,
      lieuxPeuFiables: tous.filter((x) => !x.fiable).length,
      jours,
      lieux: lieux
        .map((l) => ({ id: l.id, enseigne: l.enseigne, ville: l.ville, ...resume(previsions.get(l.id)!) }))
        .sort((a, b) => b.totalCents - a.totalCents),
    });
  })
);
