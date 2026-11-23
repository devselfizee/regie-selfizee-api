import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { Limiteur } from "../lib/limiteur.js";

// Accueil du front : l'utilisateur tape son e-mail, la Régie lui dit vers quelle connexion aller
// (salariés : realm konitys ; clients : realm « regie »). Route publique, montée sous /public/v1/connexion.
// Elle révèle seulement qu'une adresse a un compte client actif : limitée en fréquence par IP.
export const connexionRouter = Router();

const MINUTE = 60_000;
const essaisParIp = new Limiteur(20, 10 * MINUTE);

export type SorteConnexion = "salarie" | "client" | "choix";

/** Connexion à proposer : client seulement si un compte client actif existe ; les deux si l'adresse est aussi salariée */
export function sorteConnexion(o: { clientsActifs: boolean; client: boolean; salarie: boolean }): SorteConnexion {
  if (!o.clientsActifs || !o.client) return "salarie";
  return o.salarie ? "choix" : "client";
}

// POST /public/v1/connexion { email } → { compte: "salarie" | "client" | "choix" }
connexionRouter.post(
  "/",
  asynchrone(async (req, res) => {
    if (!essaisParIp.essayer(req.ip ?? "?")) throw new HttpError(429, "TROP_D_ESSAIS", "Trop d'essais. Réessayez dans quelques minutes.");
    const { email } = z.object({ email: z.email().max(200) }).parse(req.body);
    const adresse = { equals: email.trim(), mode: "insensitive" as const };
    const clientsActifs = Boolean(process.env.KEYCLOAK_REGIE_REALM?.trim());
    const [client, salarie] = clientsActifs
      ? await Promise.all([
          prisma.user.count({ where: { compte: "REGIE", email: adresse, isActive: true, entreprise: { actif: true } } }),
          prisma.user.count({ where: { compte: "KONITYS", email: adresse, isActive: true } }),
        ])
      : [0, 0];
    res.json({ compte: sorteConnexion({ clientsActifs, client: client > 0, salarie: salarie > 0 }) });
  })
);
