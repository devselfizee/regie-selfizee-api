import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { authMiddleware } from "./middleware/auth.js";
import { ingestionRouter } from "./routes/ingestion.js";
import { importsRouter } from "./routes/imports.js";
import { referentielRouter } from "./routes/referentiel.js";
import { lieuxRouter } from "./routes/lieux.js";
import { affectationsRouter, bornesRouter } from "./routes/bornes.js";
import { statsRouter } from "./routes/stats.js";
import { exportRouter } from "./routes/exports.js";
import { utilisateursRouter } from "./routes/utilisateurs.js";
import { commissionsRouter, reversementsRouter } from "./routes/commissions.js";
import { alertesRouter } from "./routes/alertes.js";
import { segmentsRouter } from "./routes/segments.js";
import { rapprochementRouter } from "./routes/rapprochement.js";
import { coutsBornesRouter, coutsRouter, interventionsRouter, rentabiliteRouter } from "./routes/couts.js";
import { exiger, utilisateurCourant } from "./middleware/utilisateur.js";
import { reponseErreur } from "./lib/http.js";

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

  // Ingestion bornes : authentification par clé borne, pas de CORS (machine à machine)
  app.use(
    "/ingest/v1",
    express.json({ limit: process.env.INGEST_BODY_LIMIT ?? "2mb" }),
    ingestionRouter
  );

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
  // Droits par rôle (CDC §9.2). Les lieux, stats et exports filtrent en plus
  // selon le périmètre de l'utilisateur (ses lieux pour un commercial).
  const tech = exiger("ADMIN", "TECHNICIEN");
  const ventes = exiger("ADMIN", "COMMERCIAL", "PARTENAIRE");
  app.use("/api/utilisateurs", utilisateursRouter);
  app.use("/api/referentiel", referentielRouter);
  app.use("/api/lieux", lieuxRouter);
  app.use("/api/imports", tech, importsRouter);
  app.use("/api/bornes", tech, bornesRouter);
  app.use("/api/bornes", tech, coutsBornesRouter);
  app.use("/api/couts", tech, coutsRouter);
  app.use("/api/interventions", tech, interventionsRouter);
  app.use("/api/rentabilite", exiger("ADMIN"), rentabiliteRouter);
  app.use("/api/affectations", tech, affectationsRouter);
  app.use("/api/stats/segments", ventes, segmentsRouter);
  app.use("/api/stats", ventes, statsRouter);
  app.use("/api/export", ventes, exportRouter);
  app.use("/api/commissions", commissionsRouter);
  app.use("/api/reversements", reversementsRouter);
  app.use("/api/alertes", alertesRouter);
  app.use("/api/rapprochement", exiger("ADMIN"), rapprochementRouter);

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
