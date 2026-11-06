import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { asynchrone } from "../lib/http.js";
import { traiterEvenementsMailjet, type EvenementMailjet } from "../souvenir/envois.js";

// Webhook des événements Mailjet (rebonds des mails de la page souvenir, CDC page souvenir § 6 et § 11).
// À déclarer dans Mailjet (Compte → Event notifications / webhooks, événements « bounce » et « blocked ») avec l'URL :
//   https://<api>/webhooks/v1/mailjet?cle=<MAILJET_WEBHOOK_SECRET>
// Mailjet envoie un événement, ou un tableau s'ils sont groupés ; il réessaie tant qu'on ne répond pas 200.

export const webhookMailjetRouter = Router();

const memeCle = (recue: string, attendue: string) =>
  timingSafeEqual(createHash("sha256").update(recue).digest(), createHash("sha256").update(attendue).digest());

webhookMailjetRouter.post(
  "/",
  asynchrone(async (req, res) => {
    const attendue = process.env.MAILJET_WEBHOOK_SECRET;
    if (!attendue) return void res.status(503).json({ error: "WEBHOOK_DESACTIVE" });
    const cle = req.query.cle;
    if (typeof cle !== "string" || !memeCle(cle, attendue)) return void res.status(401).json({ error: "CLE_INVALIDE" });
    const corps: unknown = req.body;
    const evenements = (Array.isArray(corps) ? corps : [corps]).filter((e): e is EvenementMailjet => Boolean(e) && typeof e === "object");
    const n = await traiterEvenementsMailjet(evenements);
    if (n) console.log(`Mailjet : ${n} mail(s) de la page souvenir en rebond`);
    res.status(200).json({ ok: true });
  })
);
