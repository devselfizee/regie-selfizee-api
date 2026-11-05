import { Router } from "express";
import type { UserRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { envoyerEmail } from "../lib/envoi.js";
import { verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { LIBELLES } from "../alertes/notifications.js";
import { titreLotCodes } from "../codes/codes.js";

// Suivi de la fiche lieu (demande de Sébastien) : commentaires de l'équipe avec mentions,
// et une timeline qui les mêle à l'histoire du lieu. Interne : jamais visible du partenaire.

const EQUIPE: UserRole[] = ["ADMIN", "COMMERCIAL", "TECHNICIEN"];
const APP_URL = () => (process.env.APP_URL ?? "").replace(/\/+$/, "");
const echapper = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const nomComplet = (u: { prenom: string; nom: string }) => `${u.prenom} ${u.nom}`.trim();

async function lieuDuSuivi(req: UtilisateurRequest) {
  const u = req.utilisateur;
  if (!u || !EQUIPE.includes(u.role)) throw new HttpError(403, "INTERDIT", "Le suivi est réservé à l'équipe Selfizee");
  const lieuId = Number(req.params.id);
  await verifierAccesLieu(u, lieuId);
  return lieuId;
}

/** Membres de l'équipe qui voient ce lieu : eux seuls peuvent être mentionnés */
async function mentionnables(lieuId: number) {
  const lieu = await prisma.lieu.findUnique({ where: { id: lieuId }, select: { commercialId: true } });
  return prisma.user.findMany({
    where: { isActive: true, OR: [{ role: { in: ["ADMIN", "TECHNICIEN"] } }, { role: "COMMERCIAL", id: lieu?.commercialId ?? -1 }] },
    orderBy: [{ prenom: "asc" }, { nom: "asc" }],
    select: { id: true, prenom: true, nom: true, email: true, role: true },
  });
}

const commentaireSchema = z.object({
  texte: z.string().trim().min(1).max(5000),
  mentionIds: z.array(z.number().int()).max(50).default([]),
});

const selectCommentaire = {
  id: true,
  lieuId: true,
  texte: true,
  createdAt: true,
  modifieLe: true,
  auteur: { select: { id: true, prenom: true, nom: true, photoUrl: true } },
  mentions: { select: { luLe: true, user: { select: { id: true, prenom: true, nom: true } } } },
} as const;

/** Prévient par e-mail les personnes nouvellement mentionnées */
async function notifierMentions(lieuId: number, auteur: { prenom: string; nom: string }, texte: string, userIds: number[]) {
  if (!userIds.length) return;
  const [lieu, users] = await Promise.all([
    prisma.lieu.findUnique({ where: { id: lieuId }, select: { enseigne: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { email: true } }),
  ]);
  const lien = APP_URL() ? `${APP_URL()}/lieux/${lieuId}?onglet=suivi` : null;
  const sujet = `${nomComplet(auteur)} vous a mentionné · ${lieu?.enseigne ?? "lieu"}`;
  const html = `<p><strong>${echapper(nomComplet(auteur))}</strong> vous a mentionné sur la fiche de <strong>${echapper(lieu?.enseigne ?? "")}</strong> :</p>
<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;white-space:pre-wrap">${echapper(texte)}</blockquote>${
    lien ? `<p><a href="${lien}">Ouvrir le suivi du lieu</a></p>` : ""
  }`;
  for (const u of users) {
    const erreur = await envoyerEmail(u.email, sujet, html).catch((e: Error) => e.message);
    if (erreur) console.log(`[mention] e-mail non envoyé à ${u.email} : ${erreur}`);
  }
}

export const suiviLieuRouter = Router();

// GET /api/lieux/:id/mentionnables — qui peut être mentionné sur ce lieu
suiviLieuRouter.get(
  "/:id/mentionnables",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = await lieuDuSuivi(req);
    res.json((await mentionnables(lieuId)).map(({ email: _e, ...u }) => u));
  })
);

// POST /api/lieux/:id/commentaires { texte, mentionIds }
suiviLieuRouter.post(
  "/:id/commentaires",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = await lieuDuSuivi(req);
    const c = commentaireSchema.parse(req.body);
    const permis = new Set((await mentionnables(lieuId)).map((u) => u.id));
    // On ne se notifie pas soi-même
    const ids = [...new Set(c.mentionIds)].filter((id) => permis.has(id) && id !== req.utilisateur!.id);
    const cree = await prisma.commentaireLieu.create({
      data: { lieuId, auteurId: req.utilisateur!.id, texte: c.texte, mentions: { create: ids.map((userId) => ({ userId })) } },
      select: selectCommentaire,
    });
    await notifierMentions(lieuId, req.utilisateur!, c.texte, ids);
    res.status(201).json(cree);
  })
);

// GET /api/lieux/:id/timeline — commentaires et histoire du lieu, du plus récent au plus ancien.
// Marque comme lues les mentions de l'utilisateur sur ce lieu.
suiviLieuRouter.get(
  "/:id/timeline",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = await lieuDuSuivi(req);
    const admin = req.utilisateur!.role === "ADMIN";
    const [lieu, commentaires, affectations, alertes, evenements, journaux, contrats, reversements, lotsCodes, codesSupprimes] = await Promise.all([
      prisma.lieu.findUnique({ where: { id: lieuId }, select: { createdAt: true, dateSignature: true, dateInstallation: true } }),
      prisma.commentaireLieu.findMany({ where: { lieuId }, select: selectCommentaire }),
      prisma.affectationBorne.findMany({ where: { lieuId }, select: { id: true, borneId: true, debut: true, fin: true, emplacementNotes: true, borne: { select: { identifiant: true } } } }),
      prisma.alerte.findMany({
        where: { lieuId },
        select: { id: true, type: true, niveau: true, statut: true, message: true, detecteeLe: true, resolueLe: true, commentaire: true, assignee: { select: { prenom: true, nom: true, photoUrl: true } } },
      }),
      prisma.evenementLieu.findMany({ where: { lieuId }, select: { id: true, libelle: true, debut: true, fin: true, type: { select: { libelle: true } } } }),
      prisma.auditLog.findMany({
        where: { entite: { in: ["lieu", "config_evenement"] }, entiteId: String(lieuId) },
        select: { id: true, action: true, entite: true, createdAt: true, user: { select: { prenom: true, nom: true, photoUrl: true } } },
      }),
      admin ? prisma.contratCommission.findMany({ where: { lieuId }, select: { id: true, version: true, dateEffet: true, dateFin: true, modele: true, motifAvenant: true } }) : [],
      admin ? prisma.reversement.findMany({ where: { lieuId, payeLe: { not: null } }, select: { id: true, periodeDebut: true, periodeFin: true, payeLe: true, montantAReverserCents: true } }) : [],
      // Codes de remise donnés au lieu (page réservée aux admins), et ceux supprimés depuis
      admin
        ? prisma.lotCodesRemise.findMany({
            where: { lieuId },
            select: { id: true, type: true, quantite: true, pourcentage: true, libelle: true, nbCodes: true, expireLe: true, seulementLieu: true, createdAt: true, creePar: { select: { prenom: true, nom: true, photoUrl: true } } },
          })
        : [],
      admin
        ? prisma.auditLog.findMany({
            where: { entite: "lot_codes_remise", action: "SUPPRESSION_CODES", avant: { path: ["lieuId"], equals: lieuId } },
            select: { id: true, entiteId: true, avant: true, createdAt: true, user: { select: { prenom: true, nom: true, photoUrl: true } } },
          })
        : [],
    ]);
    if (!lieu) throw new HttpError(404, "INTROUVABLE");

    // Interventions sur les bornes pendant qu'elles étaient au lieu
    const interventions = affectations.length
      ? await prisma.intervention.findMany({
          where: { OR: affectations.map((a) => ({ borneId: a.borneId, date: { gte: a.debut, ...(a.fin ? { lte: a.fin } : {}) } })) },
          select: { id: true, date: true, motif: true, compteRendu: true, borne: { select: { identifiant: true } }, technicien: { select: { prenom: true, nom: true, photoUrl: true } } },
        })
      : [];

    // Qui a résolu chaque alerte (journal d'audit, depuis le 03/11/2026 ; avant : la personne qui l'avait prise en charge)
    const resolutions = alertes.some((a) => a.resolueLe)
      ? await prisma.auditLog.findMany({
          where: { entite: "alerte", entiteId: { in: alertes.filter((a) => a.resolueLe).map((a) => String(a.id)) }, action: { in: ["RESOLUE", "IGNOREE"] } },
          orderBy: { createdAt: "desc" },
          select: { entiteId: true, user: { select: { prenom: true, nom: true, photoUrl: true } } },
        })
      : [];

    type Element = {
      cle: string;
      type: string;
      date: Date;
      titre: string;
      detail?: string | null;
      auteur?: string | null;
      /** Photo du compte Konitys de l'auteur */
      auteurPhoto?: string | null;
      ton?: string;
      commentaire?: (typeof commentaires)[number];
      /** Résolution d'une alerte : l'alerte à laquelle elle répond */
      reponseA?: { titre: string; date: Date; detail: string };
    };
    const el: Element[] = [];
    const auteur = (u: { prenom: string; nom: string } | null) => (u ? nomComplet(u) : null);
    const photo = (u: { photoUrl?: string | null } | null) => u?.photoUrl ?? null;

    for (const c of commentaires) el.push({ cle: `c${c.id}`, type: "COMMENTAIRE", date: c.createdAt, titre: "Commentaire", auteur: auteur(c.auteur), auteurPhoto: photo(c.auteur), commentaire: c });
    el.push({ cle: "creation", type: "LIEU", date: lieu.createdAt, titre: "Fiche créée" });
    if (lieu.dateSignature) el.push({ cle: "signature", type: "CONTRAT", date: lieu.dateSignature, titre: "Contrat signé", ton: "bon" });
    if (lieu.dateInstallation) el.push({ cle: "installation", type: "CONTRAT", date: lieu.dateInstallation, titre: "Installation", ton: "bon" });
    for (const a of affectations) {
      el.push({ cle: `a${a.id}`, type: "BORNE", date: a.debut, titre: `Borne ${a.borne.identifiant} installée`, detail: a.emplacementNotes });
      if (a.fin) el.push({ cle: `a${a.id}f`, type: "BORNE", date: a.fin, titre: `Borne ${a.borne.identifiant} retirée` });
    }
    for (const i of interventions)
      el.push({ cle: `i${i.id}`, type: "INTERVENTION", date: i.date, titre: `Intervention sur ${i.borne.identifiant} : ${i.motif}`, detail: i.compteRendu, auteur: auteur(i.technicien), auteurPhoto: photo(i.technicien) });
    for (const a of alertes) {
      el.push({ cle: `al${a.id}`, type: "ALERTE", date: a.detecteeLe, titre: `Alerte : ${LIBELLES[a.type]}`, detail: a.message, ton: a.niveau === "CRITIQUE" ? "mauvais" : "attention" });
      if (a.resolueLe) {
        const par = resolutions.find((r) => r.entiteId === String(a.id))?.user ?? a.assignee;
        const automatique = !par && (a.commentaire ?? "").startsWith("Résolue automatiquement");
        el.push({
          cle: `al${a.id}r`,
          type: "ALERTE",
          date: a.resolueLe,
          titre: `Alerte ${a.statut === "IGNOREE" ? "ignorée" : "résolue"} : ${LIBELLES[a.type]}`,
          detail: a.commentaire,
          auteur: automatique ? "Régie (automatique)" : (auteur(par) ?? "Auteur inconnu (avant le suivi des résolutions)"),
          auteurPhoto: photo(par),
          ton: "bon",
          reponseA: { titre: `Alerte : ${LIBELLES[a.type]}`, date: a.detecteeLe, detail: a.message },
        });
      }
    }
    for (const e of evenements) el.push({ cle: `e${e.id}`, type: "EVENEMENT", date: e.debut, titre: `${e.type.libelle} : ${e.libelle}` });
    for (const j of journaux)
      el.push({
        cle: `j${j.id}`,
        type: "LIEU",
        date: j.createdAt,
        titre:
          j.entite === "config_evenement"
            ? j.action === "PUBLICATION" ? "Fiche événement publiée sur la borne" : "Fiche événement (borne) modifiée"
            : j.action === "CREATION" ? "Fiche créée" : j.action === "TARIFS" ? "Tarifs du lieu modifiés" : "Fiche modifiée",
        auteur: auteur(j.user), auteurPhoto: photo(j.user),
      });
    for (const c of contrats)
      el.push({ cle: `k${c.id}`, type: "CONTRAT", date: c.dateEffet, titre: c.version > 1 ? `Avenant n° ${c.version - 1} au contrat de commission` : "Contrat de commission", detail: c.motifAvenant });
    for (const l of lotsCodes)
      el.push({ cle: `lc${l.id}`, type: "CODES", date: l.createdAt, titre: titreLotCodes(l), auteur: auteur(l.creePar), auteurPhoto: photo(l.creePar) });
    for (const s of codesSupprimes) {
      const n = ((s.avant as { codes?: string[] } | null)?.codes ?? []).length;
      el.push({ cle: `ls${s.id}`, type: "CODES", date: s.createdAt, titre: `${n} code${n > 1 ? "s" : ""} de remise supprimé${n > 1 ? "s" : ""} (lot #${s.entiteId})`, auteur: auteur(s.user), auteurPhoto: photo(s.user) });
    }
    for (const r of reversements)
      el.push({ cle: `r${r.id}`, type: "COMMISSION", date: r.payeLe!, titre: `Commission payée : ${(r.montantAReverserCents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}` });

    // Une création tracée remplace la date de création brute
    const trie = el.filter((e) => !(e.cle === "creation" && journaux.some((j) => j.entite === "lieu" && j.action === "CREATION"))).sort((a, b) => b.date.getTime() - a.date.getTime());

    await prisma.mentionCommentaire.updateMany({ where: { userId: req.utilisateur!.id, luLe: null, commentaire: { lieuId } }, data: { luLe: new Date() } });
    res.json(trie);
  })
);

export const commentairesRouter = Router();

async function commentaireModifiable(req: UtilisateurRequest) {
  const c = await prisma.commentaireLieu.findUnique({ where: { id: Number(req.params.id) } });
  if (!c) throw new HttpError(404, "INTROUVABLE");
  await verifierAccesLieu(req.utilisateur, c.lieuId);
  if (c.auteurId !== req.utilisateur!.id && req.utilisateur!.role !== "ADMIN")
    throw new HttpError(403, "INTERDIT", "Seul l'auteur (ou un administrateur) peut modifier ce commentaire");
  return c;
}

// GET /api/commentaires/mentions — mes mentions récentes (non lues d'abord)
commentairesRouter.get(
  "/mentions",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const mentions = await prisma.mentionCommentaire.findMany({
      where: { userId: req.utilisateur!.id },
      orderBy: { commentaire: { createdAt: "desc" } },
      take: 100,
      select: {
        luLe: true,
        commentaire: { select: { id: true, texte: true, createdAt: true, auteur: { select: { prenom: true, nom: true } }, lieu: { select: { id: true, enseigne: true, ville: true } } } },
      },
    });
    res.json({ nonLues: mentions.filter((m) => !m.luLe).length, mentions });
  })
);

// PUT /api/commentaires/:id { texte, mentionIds } — les nouvelles mentions sont prévenues
commentairesRouter.put(
  "/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const ancien = await commentaireModifiable(req);
    const c = commentaireSchema.parse(req.body);
    const permis = new Set((await mentionnables(ancien.lieuId)).map((u) => u.id));
    const ids = [...new Set(c.mentionIds)].filter((id) => permis.has(id) && id !== req.utilisateur!.id);
    const deja = new Set((await prisma.mentionCommentaire.findMany({ where: { commentaireId: ancien.id }, select: { userId: true } })).map((m) => m.userId));
    const nouveaux = ids.filter((id) => !deja.has(id));
    const maj = await prisma.$transaction(async (db) => {
      await db.mentionCommentaire.deleteMany({ where: { commentaireId: ancien.id, userId: { notIn: ids } } });
      if (nouveaux.length) await db.mentionCommentaire.createMany({ data: nouveaux.map((userId) => ({ commentaireId: ancien.id, userId })) });
      return db.commentaireLieu.update({ where: { id: ancien.id }, data: { texte: c.texte, modifieLe: new Date() }, select: selectCommentaire });
    });
    await notifierMentions(ancien.lieuId, req.utilisateur!, c.texte, nouveaux);
    res.json(maj);
  })
);

// DELETE /api/commentaires/:id
commentairesRouter.delete(
  "/:id",
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const c = await commentaireModifiable(req);
    await prisma.commentaireLieu.delete({ where: { id: c.id } });
    res.status(204).end();
  })
);
