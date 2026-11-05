import { Router } from "express";
import { asynchrone } from "../lib/http.js";
import { authSynchro } from "../middleware/authSynchro.js";
import { journaliserRejet } from "../ingestion/journal.js";
import { corpsWebhook, recevoirMedia } from "../synchro-pikcloud/reception.js";
import { declencherTelechargement } from "../synchro-pikcloud/telechargement.js";

// Webhook appelé par PikCloud à chaque média de séance reçu d'une borne (docs/synchronisation-pikcloud.md).
// Monté sous /webhooks/v1/pikcloud, sans CORS (machine à machine).
export const synchroPikcloudRouter = Router();

// POST /webhooks/v1/pikcloud/medias
// Toujours 200 avec une entrée data et/ou photo (succès ou code 4000-4999) ; 400 seulement si le corps
// n'est pas celui du contrat (bug à corriger d'un côté ou de l'autre : visible dans la page Imports)
synchroPikcloudRouter.post(
  "/medias",
  authSynchro,
  asynchrone(async (req, res) => {
    const c = corpsWebhook.safeParse(req.body);
    if (!c.success) {
      const message = c.error.issues.map((i) => `${i.path.join(".") || "corps"} : ${i.message}`).join(" ; ");
      await journaliserRejet(req, "MEDIAS", "SCHEMA_INVALIDE", message);
      return res.status(400).json({ error: "SCHEMA_INVALIDE", message });
    }
    res.json(await recevoirMedia(c.data, req.ip));
    declencherTelechargement();
  })
);
