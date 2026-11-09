import { Router } from "express";
import { z } from "zod";
import { utiliserCode, verifierCode } from "../codes/codes.js";
import { asynchrone } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { cheminAbsolu } from "../lib/stockage.js";
import { cheminZip, statutPourBorne, urlZipValide } from "../config-evenement/zipBorne.js";
import { authBorne, type BorneRequest } from "../middleware/authBorne.js";
import { journaliserRejet } from "../ingestion/journal.js";
import { ingererLotTransactions } from "../ingestion/transactions.js";
import { ingererHeartbeats } from "../ingestion/heartbeats.js";
import { ingererLotParcours } from "../ingestion/parcours.js";
import {
  erreursParLigne,
  erreursUniquementSurLignes,
  formaterErreurs,
  validerLotParcours,
  type LotParcoursJson,
  validerLotHeartbeats,
  validerLotTransactions,
  type LotHeartbeatsJson,
  type LotTransactionsJson,
} from "../ingestion/validation.js";

export const ingestionRouter = Router();

// POST /ingest/v1/transactions
ingestionRouter.post(
  "/transactions",
  authBorne("TRANSACTIONS"),
  asynchrone<BorneRequest>(async (req, res) => {
    // Une transaction invalide ne bloque pas le lot : seule l'enveloppe est bloquante
    if (!validerLotTransactions(req.body) && !erreursUniquementSurLignes(validerLotTransactions.errors ?? [])) {
      const message = formaterErreurs(validerLotTransactions.errors);
      await journaliserRejet(req, "TRANSACTIONS", "SCHEMA_INVALIDE", message, req.borne!.id);
      return res.status(400).json({ error: "SCHEMA_INVALIDE", message });
    }

    const resultat = await ingererLotTransactions(req.borne!, req.body as LotTransactionsJson, req.ip);
    // 200 même en cas de lignes rejetées : la borne ne doit pas renvoyer le lot en boucle.
    res.json(resultat);
  })
);

// POST /ingest/v1/parcours — parcours invité, une séance par objet (avenant du 26/10/2026)
ingestionRouter.post(
  "/parcours",
  authBorne("PARCOURS"),
  asynchrone<BorneRequest>(async (req, res) => {
    // Comme les ventes : seule l'enveloppe est bloquante, un parcours mal formé est refusé seul
    let invalides = new Map<number, string>();
    if (!validerLotParcours(req.body)) {
      const erreurs = validerLotParcours.errors ?? [];
      const lignes = Array.isArray((req.body as { parcours?: unknown })?.parcours);
      if (!lignes || !erreursUniquementSurLignes(erreurs, "parcours")) {
        const message = formaterErreurs(erreurs);
        await journaliserRejet(req, "PARCOURS", "SCHEMA_INVALIDE", message, req.borne!.id);
        return res.status(400).json({ error: "SCHEMA_INVALIDE", message });
      }
      invalides = erreursParLigne(erreurs, "parcours");
    }
    res.json(await ingererLotParcours(req.borne!, req.body as LotParcoursJson, req.ip, "API", invalides));
  })
);

// POST /ingest/v1/heartbeats
ingestionRouter.post(
  "/heartbeats",
  authBorne("HEARTBEAT"),
  asynchrone<BorneRequest>(async (req, res) => {
    if (!validerLotHeartbeats(req.body)) {
      const message = formaterErreurs(validerLotHeartbeats.errors);
      await journaliserRejet(req, "HEARTBEAT", "SCHEMA_INVALIDE", message, req.borne!.id);
      return res.status(400).json({ error: "SCHEMA_INVALIDE", message });
    }
    res.json(await ingererHeartbeats(req.borne!, req.body as LotHeartbeatsJson));
  })
);

// ─── Codes de remise (demande de Sébastien, 02/11/2026) ───
// Réponse 200 avec valide / ok à false quand le code est refusé : ce n'est pas une erreur de la borne.

const corpsCode = z.object({ borne_id: z.string(), code: z.string().trim().min(1).max(20) });

const invalide = async (req: BorneRequest, res: import("express").Response, err: z.ZodError, type: "CODES" | "CONFIG" = "CODES") => {
  const message = err.issues.map((i) => `${i.path.join(".") || "corps"} : ${i.message}`).join(" ; ");
  await journaliserRejet(req, type, "SCHEMA_INVALIDE", message, req.borne!.id);
  res.status(400).json({ error: "SCHEMA_INVALIDE", message });
};

// POST /ingest/v1/codes/verifier { borne_id, code } — checkCode : impressions restantes et date limite
ingestionRouter.post(
  "/codes/verifier",
  authBorne("CODES"),
  asynchrone<BorneRequest>(async (req, res) => {
    const c = corpsCode.safeParse(req.body);
    if (!c.success) return invalide(req, res, c.error);
    res.json(await verifierCode(req.borne!.id, c.data.code));
  })
);

// POST /ingest/v1/codes/utiliser { borne_id, code, nb, utilisation_id? } — useCode : décompte nb impressions,
// ou ce qu'il reste (ok à false, accordees dit combien). utilisation_id (la séance) : un renvoi ne décompte pas deux fois.
ingestionRouter.post(
  "/codes/utiliser",
  authBorne("CODES"),
  asynchrone<BorneRequest>(async (req, res) => {
    const c = corpsCode
      .extend({ nb: z.number().int().min(1).max(100), utilisation_id: z.string().trim().min(1).max(128).optional() })
      .safeParse(req.body);
    if (!c.success) return invalide(req, res, c.error);
    res.json(await utiliserCode(req.borne!.id, c.data.code, c.data.nb, c.data.utilisation_id ?? null));
  })
);

// ─── Zip de l'événement (comme getEvent et e/zip/download du booth) ───

// POST /ingest/v1/evenements/statut { borne_id, code } — état du zip de l'événement et URL de téléchargement
// (15 minutes). status : complete | incomplete (jamais publié) | obsolete (à republier) | unknown (code inconnu ou
// événement d'un autre lieu que celui où la borne est installée). La borne compare `version` à la sienne avant de
// télécharger, et vérifie le fichier reçu avec `sha256`.
ingestionRouter.post(
  "/evenements/statut",
  authBorne("CONFIG"),
  asynchrone<BorneRequest>(async (req, res) => {
    const c = z.object({ borne_id: z.string(), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,8}$/) }).safeParse(req.body);
    if (!c.success) return invalide(req, res, c.error, "CONFIG");
    res.setHeader("Cache-Control", "no-store");
    res.json(await statutPourBorne(req.borne!, c.data.code, `${req.protocol}://${req.get("host")}`));
  })
);

// GET /ingest/v1/evenements/:code/zip?v=&exp=&sig= — le zip publié, sur l'URL signée rendue par /statut.
// 404 sans détail si l'URL est fausse, expirée, ou si cette version n'est plus gardée (redemander l'état).
ingestionRouter.get(
  "/evenements/:code/zip",
  asynchrone(async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const version = /^[A-Z0-9]{3,8}$/.test(code) ? urlZipValide(code, req.query.v, req.query.exp, req.query.sig) : null;
    if (version === null) return void res.status(404).json({ error: "INTROUVABLE" });
    const e = await prisma.configEvenement.findUnique({ where: { code }, select: { version: true, zipSha256: true } });
    if (!e) return void res.status(404).json({ error: "INTROUVABLE" });
    const absolu = cheminAbsolu(cheminZip(code, version));
    res.setHeader("Content-Disposition", `attachment; filename="${code}.zip"`);
    res.setHeader("Cache-Control", "private, no-store");
    if (version === e.version && e.zipSha256) res.setHeader("X-Zip-Sha256", e.zipSha256);
    // sendFile : reprise des téléchargements interrompus (Range), Content-Length
    res.sendFile(absolu, { headers: { "Content-Type": "application/zip" }, etag: false, lastModified: false }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "INTROUVABLE" });
    });
  })
);

