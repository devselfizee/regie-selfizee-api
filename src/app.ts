import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { authMiddleware } from "./middleware/auth.js";
import { ingestionRouter } from "./routes/ingestion.js";
import { importsRouter } from "./routes/imports.js";
import { referentielRouter } from "./routes/referentiel.js";
import { lieuxRouter } from "./routes/lieux.js";
import { accesLieuRouter } from "./routes/accesLieu.js";
import { affectationsRouter, bornesRouter } from "./routes/bornes.js";
import { statsRouter } from "./routes/stats.js";
import { exportRouter } from "./routes/exports.js";
import { utilisateursRouter } from "./routes/utilisateurs.js";
import { commissionsRouter, reversementsRouter } from "./routes/commissions.js";
import { alertesRouter } from "./routes/alertes.js";
import { segmentsRouter } from "./routes/segments.js";
import { rapprochementRouter } from "./routes/rapprochement.js";
import { previsionsRouter } from "./routes/previsions.js";
import { prospectsRouter } from "./routes/prospects.js";
import { ventesRouter } from "./routes/ventes.js";
import { cartesTestRouter } from "./routes/cartesTest.js";
import { codesRemiseRouter } from "./routes/codesRemise.js";
import { supervisionRouter } from "./routes/supervision.js";
import { calendrierMarketingRouter } from "./routes/calendrierMarketing.js";
import { concurrentsRouter } from "./routes/concurrents.js";
import { demoRouter } from "./routes/demo.js";
import { contexteRouter, evenementsLieuRouter, evenementsRouter } from "./routes/contexte.js";
import { coutsBornesRouter, coutsRouter, interventionsRouter, rentabiliteRouter } from "./routes/couts.js";
import { mesPhotosRouter } from "./routes/mesPhotos.js";
import { synchroPikcloudRouter } from "./routes/synchroPikcloud.js";
import { souvenirRouter } from "./routes/souvenir.js";
import { webhookMailjetRouter } from "./routes/webhookMailjet.js";
import { rgpdRouter } from "./routes/rgpd.js";
import { modelesMailRouter } from "./routes/modelesMail.js";
import { mediasLieuRouter, mediasRouter } from "./routes/medias.js";
import { souvenirLieuRouter } from "./routes/souvenirLieu.js";
import { configEvenementRouter } from "./routes/configEvenement.js";
import { cadresEvenementRouter } from "./routes/cadresEvenement.js";
import { illustrationsEvenementRouter } from "./routes/illustrationsEvenement.js";
import { illustrationsSeriesRouter } from "./routes/illustrationsSeries.js";
import { commentairesRouter, suiviLieuRouter } from "./routes/suivi.js";
import { tarifsLieuRouter, tarifsRouter } from "./routes/tarifs.js";
import { utilisateurCourant } from "./middleware/utilisateur.js";
import { requirePerm } from "./middleware/permissions.js";
import { reponseErreur } from "./lib/http.js";
import { buildPermissionsSchema } from "./permissions/schema.js";

// BigInt (ids des transactions, lots…) sérialisé en chaîne dans les réponses JSON
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

export function creerApp() {
  const app = express();
  app.set("trust proxy", true); // derrière le reverse proxy Coolify

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Droits Konitys : schéma public lu par le gateway (Admin Panel → Profils & Droits → Rafraîchir), sans jeton.
  // Les deux chemins essayés par le gateway, déclarés avant l'authentification de /api.
  app.get(["/adminpanel/permissions-schema", "/api/adminpanel/permissions-schema"], cors(), (_req, res) => {
    res.json(buildPermissionsSchema());
  });

  // Ingestion bornes : authentification par clé borne, pas de CORS (machine à machine)
  app.use(
    "/ingest/v1",
    express.json({ limit: process.env.INGEST_BODY_LIMIT ?? "2mb" }),
    ingestionRouter
  );

  // Page publique « Mes photos » (invités, sans connexion) : deux routes, limitées en fréquence
  app.use(
    "/public/v1/mes-photos",
    cors({ origin: process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? "*" }),
    express.json({ limit: "2kb" }),
    mesPhotosRouter
  );

  // Page souvenir (myevent.selfizee.fr) : séances et codes pour son serveur (secret partagé), visuels sur URL signée
  app.use("/souvenir/v1", express.json({ limit: "8kb" }), souvenirRouter);

  // Plateforme RGPD (rgpd.selfizee.fr) : données d'une adresse sur le lien chiffré envoyé par mail, sans connexion
  app.use(
    "/rgpd/v1",
    cors({ origin: process.env.RGPD_CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? "*" }),
    express.json({ limit: "8kb" }),
    rgpdRouter
  );

  // Webhook PikCloud : médias des séances, secret partagé X-Synchro-Token, pas de CORS (machine à machine)
  app.use("/webhooks/v1/pikcloud", express.json({ limit: "64kb" }), synchroPikcloudRouter);
  // Webhook Mailjet : rebonds des mails de la page souvenir, clé partagée dans l'URL (?cle=MAILJET_WEBHOOK_SECRET)
  app.use("/webhooks/v1/mailjet", express.json({ limit: "1mb" }), webhookMailjetRouter);

  // Cadres du studio : rendu PNG + JSON Fabric avec ses illustrations, jusqu'à 25 Mo (lu avant la limite générale)
  app.use(["/api/lieux/:id/evenement/cadres", "/api/lieux/:id/evenements-ponctuels/:eid/cadres"], express.json({ limit: "30mb" }));
  // Photos d'exemple (illustrations) : une image en data URL, 15 Mo au plus
  app.use(["/api/lieux/:id/evenement/illustrations", "/api/lieux/:id/evenements-ponctuels/:eid/illustrations", "/api/illustrations-series"], express.json({ limit: "15mb" }));

  // Back-office : CORS + Keycloak
  app.use(
    "/api",
    cors({
      origin: process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? "*",
      credentials: true,
      // Nom des fichiers exportés (CSV, PDF) : sinon le navigateur cache cet en-tête au front
      exposedHeaders: ["Content-Disposition"],
    }),
    // Relevés monétiques envoyés en texte CSV dans le JSON : quelques Mo
    express.json({ limit: "20mb" }),
    authMiddleware,
    utilisateurCourant
  );
  // Droits Konitys (docs/PERMISSIONS_APP_INTEGRATION.md) : lecture du domaine au montage, une clé par route d'écriture
  // dans les routeurs. Les lieux, stats et exports filtrent en plus selon le périmètre (lieux.view_any / view_own).
  app.use("/api/utilisateurs", utilisateursRouter);
  app.use("/api/referentiel", referentielRouter);
  app.use("/api/lieux", lieuxRouter);
  // Accès au lieu : localisation des clés (texte, photos), disponibilité des contacts
  app.use("/api/lieux", accesLieuRouter);
  app.use("/api/lieux", evenementsLieuRouter);
  app.use("/api/lieux", configEvenementRouter);
  app.use("/api/lieux", cadresEvenementRouter);
  app.use("/api/lieux", illustrationsEvenementRouter);
  app.use("/api/illustrations-series", illustrationsSeriesRouter);
  app.use("/api/lieux", suiviLieuRouter);
  app.use("/api/lieux", tarifsLieuRouter);
  // Galerie des médias PikCloud du lieu (droits vérifiés dans les routes : lieux du commercial, lieu du partenaire)
  app.use("/api/lieux", mediasLieuRouter);
  // Page souvenir du lieu : entonnoir et contacts opt-in lieu (mêmes droits que la galerie)
  app.use("/api/lieux", souvenirLieuRouter);
  app.use("/api/medias", mediasRouter);
  app.use("/api/tarifs", tarifsRouter);
  app.use("/api/commentaires", requirePerm("suivi.view"), commentairesRouter);
  app.use("/api/evenements", evenementsRouter);
  app.use("/api/imports", requirePerm("imports.manage"), importsRouter);
  app.use("/api/bornes", requirePerm("bornes.view"), bornesRouter);
  app.use("/api/bornes", requirePerm("bornes.view"), coutsBornesRouter);
  app.use("/api/couts", requirePerm("bornes.view"), coutsRouter);
  app.use("/api/interventions", requirePerm("bornes.view"), interventionsRouter);
  app.use("/api/rentabilite", requirePerm("rentabilite.view"), rentabiliteRouter);
  app.use("/api/affectations", requirePerm("bornes.view"), affectationsRouter);
  app.use("/api/stats/segments", requirePerm("ventes.view"), segmentsRouter);
  app.use("/api/stats/contexte", requirePerm("ventes.view"), contexteRouter);
  app.use("/api/stats", requirePerm("ventes.view"), statsRouter);
  app.use("/api/export", requirePerm("ventes.export"), exportRouter);
  app.use("/api/previsions", requirePerm("ventes.view"), previsionsRouter);
  app.use("/api/prospects", requirePerm("prospects.view"), prospectsRouter);
  app.use("/api/ventes", requirePerm("paiements.view"), ventesRouter);
  app.use("/api/cartes-test", requirePerm("cartes_test.edit"), cartesTestRouter);
  app.use("/api/codes-remise", requirePerm("codes_remise.view"), codesRemiseRouter);
  app.use("/api/supervision", requirePerm("supervision.view"), supervisionRouter);
  app.use("/api/calendrier-marketing", calendrierMarketingRouter);
  app.use("/api/concurrents", requirePerm("prospects.view"), concurrentsRouter);
  app.use("/api/demo", requirePerm("demo.manage"), demoRouter);
  app.use("/api/commissions", commissionsRouter);
  app.use("/api/reversements", reversementsRouter);
  app.use("/api/alertes", alertesRouter);
  app.use("/api/modeles-mail", modelesMailRouter);
  app.use("/api/rapprochement", requirePerm("rapprochement.view"), rapprochementRouter);

  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "JSON_INVALIDE" });
    }
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: "LOT_TROP_GROS" });
    }
    const connue = reponseErreur(err);
    if (connue) return res.status(connue.status).json(connue.body);
    console.error(err);
    res.status(500).json({ error: "ERREUR_INTERNE" });
  });

  return app;
}
