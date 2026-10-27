import { Router } from "express";
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
