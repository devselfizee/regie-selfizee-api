import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asynchrone } from "../lib/http.js";
import { perimetreLieux, verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { aujourdhui, moisDe, previsionCommission, previsionMois, prevoirLieux, resume } from "../previsions/service.js";

// Prévisions de CA (CDC V3 « pilotage »)
export const previsionsRouter = Router();

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// GET /api/previsions/lieux/:id — mois en cours jour par jour, et période de commission en cours
previsionsRouter.get(
  "/lieux/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    // Commission : mêmes droits que la fiche commissions (le commercial ne la voit pas)
    const voitCommission = ["ADMIN", "PARTENAIRE"].includes(req.utilisateur!.role);
    const [mois, commission] = await Promise.all([previsionMois(lieuId), voitCommission ? previsionCommission(lieuId) : null]);
    res.json({ mois, commission });
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
      select: { id: true, enseigne: true, ville: true, saisonnalite: true, horaires: true, saisons: true, fermetures: true },
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
    const [n1Cents, precedentCents] = await Promise.all([ca(n1.du, n1.au), ca(prec.du, prec.au)]);

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
      lieuxPeuFiables: tous.filter((x) => !x.fiable).length,
      jours,
      lieux: lieux
        .map((l) => ({ id: l.id, enseigne: l.enseigne, ville: l.ville, ...resume(previsions.get(l.id)!) }))
        .sort((a, b) => b.totalCents - a.totalCents),
    });
  })
);
