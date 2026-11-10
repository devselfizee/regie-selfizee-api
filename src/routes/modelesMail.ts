import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { emailConfigure, envoyerEmail } from "../lib/envoi.js";
import { nettoyerTexteRiche } from "../lib/texteRiche.js";
import { requirePerm } from "../middleware/permissions.js";
import { type UtilisateurRequest } from "../middleware/utilisateur.js";
import { expediteur } from "../souvenir/envois.js";
import { CLES_MODELES, estCleModele, lireModele, listeAdresses, MODELES, rendreModele, type CleModele, type Variables } from "../rgpd/modeles.js";
import { urlPlateforme } from "../rgpd/donnees.js";

// Mails paramétrables (Paramètres → E-mails RGPD) : lecture avec la page Paramètres, modification avec referentiel.edit.

export const modelesMailRouter = Router();

function cleDe(v: string): CleModele {
  if (!estCleModele(v)) throw new HttpError(404, "MODELE_INCONNU");
  return v;
}

/** Valeurs d'exemple des variables, pour l'aperçu et le mail d'essai. */
function exemple(cle: CleModele): { vars: Variables; lien?: { url: string; libelle: string } } {
  const p = urlPlateforme();
  if (cle === "RGPD_ACCES") {
    return {
      vars: {
        email: { texte: "invite@exemple.fr" },
        validite: { texte: "7 jours" },
        plateforme: { texte: p, html: `<a href="${p}" style="color:#ed195f;">${p.replace(/^https?:\/\//, "")}</a>` },
      },
      lien: { url: `${p}/e/inf/exemple`, libelle: "Accéder à mes données" },
    };
  }
  return {
    vars: {
      action: { texte: "suppression" },
      email: { texte: "invite@exemple.fr" },
      evenements: { texte: "La Ruche (Trégueux) — Halloween" },
      date: { texte: new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long", timeStyle: "short" }).format(new Date()) },
      details: { texte: "31-10-2026 22:14 — photo et données effacées", html: "31-10-2026 22:14 — photo et données effacées" },
    },
  };
}

// GET /api/modeles-mail → les modèles, avec leur texte courant, leur texte par défaut et leurs variables
modelesMailRouter.get(
  "/",
  requirePerm("pages.parametres.view"),
  asynchrone(async (_req, res) => {
    res.json(
      await Promise.all(
        CLES_MODELES.map(async (cle) => {
          const d = MODELES[cle];
          return { ...(await lireModele(cle)), nom: d.nom, description: d.description, avecDestinataires: d.avecDestinataires, variables: d.variables, defaut: { sujet: d.sujet, corps: d.corps, destinataires: d.destinataires } };
        })
      )
    );
  })
);

const corpsModele = z.object({
  sujet: z.string().trim().min(1).max(200),
  corps: z.string().max(40_000),
  destinataires: z.string().max(500).nullable().optional(),
});

// PUT /api/modeles-mail/:cle { sujet, corps, destinataires? }
modelesMailRouter.put(
  "/:cle",
  requirePerm("referentiel.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const cle = cleDe(req.params.cle);
    const b = corpsModele.parse(req.body);
    const corps = nettoyerTexteRiche(b.corps);
    if (!corps) throw new HttpError(400, "CORPS_VIDE", "Le mail ne peut pas être vide.");
    let destinataires: string | null = null;
    if (MODELES[cle].avecDestinataires) {
      const brut = (b.destinataires ?? "").split(/[,;\s]+/).filter(Boolean);
      const valides = listeAdresses(b.destinataires);
      if (valides.length !== new Set(brut.map((a) => a.toLowerCase())).size) throw new HttpError(400, "ADRESSE_INVALIDE", "Une des adresses n'est pas valide.");
      destinataires = valides.join(", ") || null;
    }
    const avant = await lireModele(cle);
    const data = { sujet: b.sujet.replace(/[\r\n]+/g, " "), corps, destinataires, modifieParId: req.utilisateur?.id ?? null };
    await prisma.modeleMail.upsert({ where: { cle }, create: { cle, ...data }, update: data });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "modele_mail", entiteId: cle, action: "MODIFICATION", avant: { sujet: avant.sujet, corps: avant.corps, destinataires: avant.destinataires }, apres: { sujet: data.sujet, corps, destinataires } },
    });
    res.json(await lireModele(cle));
  })
);

// DELETE /api/modeles-mail/:cle → retour au texte par défaut
modelesMailRouter.delete(
  "/:cle",
  requirePerm("referentiel.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const cle = cleDe(req.params.cle);
    const { count } = await prisma.modeleMail.deleteMany({ where: { cle } });
    if (count) await prisma.auditLog.create({ data: { userId: req.utilisateur?.id ?? null, entite: "modele_mail", entiteId: cle, action: "RETOUR_DEFAUT" } });
    res.json(await lireModele(cle));
  })
);

// POST /api/modeles-mail/:cle/apercu { sujet, corps } → { sujet, html } avec des valeurs d'exemple (texte en cours d'édition)
modelesMailRouter.post(
  "/:cle/apercu",
  requirePerm("pages.parametres.view"),
  asynchrone(async (req, res) => {
    const cle = cleDe(req.params.cle);
    const b = corpsModele.pick({ sujet: true, corps: true }).parse(req.body);
    const { vars, lien } = exemple(cle);
    const m = rendreModele({ sujet: b.sujet, corps: nettoyerTexteRiche(b.corps) ?? "" }, vars, lien);
    res.json({ sujet: m.sujet, html: m.html });
  })
);

// POST /api/modeles-mail/:cle/essai → le modèle enregistré, avec des valeurs d'exemple, à l'adresse de l'utilisateur
modelesMailRouter.post(
  "/:cle/essai",
  requirePerm("referentiel.edit"),
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const cle = cleDe(req.params.cle);
    const a = req.utilisateur?.email;
    if (!a) throw new HttpError(400, "ADRESSE_INCONNUE", "Votre compte n'a pas d'adresse e-mail.");
    if (!emailConfigure()) throw new HttpError(503, "ENVOI_DESACTIVE", "L'envoi des mails n'est pas configuré sur ce serveur (Mailjet).");
    const { vars, lien } = exemple(cle);
    const m = rendreModele(await lireModele(cle), vars, lien);
    const erreur = await envoyerEmail(a, `[Essai] ${m.sujet}`, m.html, [], { expediteur: expediteur(), texte: m.texte });
    if (erreur) throw new HttpError(502, "ENVOI_REFUSE", erreur);
    res.json({ envoyeA: a });
  })
);
