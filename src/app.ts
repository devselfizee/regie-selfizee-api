import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { authMiddleware } from "./middleware/auth.js";
import { ingestionRouter } from "./routes/ingestion.js";
import { importsRouter } from "./routes/imports.js";
import { referentielRouter } from "./routes/referentiel.js";
import { lieuxRouter } from "./routes/lieux.js";
import { affectationsRouter, bornesRouter } from "./routes/bornes.js";
import { exportRouter, statsRouter } from "./routes/stats.js";
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
    }),
    express.json(),
    authMiddleware
  );
  app.use("/api/imports", importsRouter);
  app.use("/api/referentiel", referentielRouter);
  app.use("/api/lieux", lieuxRouter);
  app.use("/api/bornes", bornesRouter);
  app.use("/api/affectations", affectationsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/export", exportRouter);

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
