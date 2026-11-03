import { Router } from "express";
import { z } from "zod";
import { utiliserCode, verifierCode } from "../codes/codes.js";
import { asynchrone } from "../lib/http.js";
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

const invalide = async (req: BorneRequest, res: import("express").Response, err: z.ZodError) => {
  const message = err.issues.map((i) => `${i.path.join(".") || "corps"} : ${i.message}`).join(" ; ");
  await journaliserRejet(req, "CODES", "SCHEMA_INVALIDE", message, req.borne!.id);
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
