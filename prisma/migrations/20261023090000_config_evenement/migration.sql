-- Fiche événement d'un lieu en régie : réglages et dernier config.json publié
CREATE TABLE "config_evenements" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "mot_de_passe_tableau" TEXT NOT NULL,
    "reglages" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "publiee_le" TIMESTAMPTZ(3),
    "config_publiee" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "config_evenements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "config_evenements_lieu_id_key" ON "config_evenements"("lieu_id");
CREATE UNIQUE INDEX "config_evenements_code_key" ON "config_evenements"("code");

ALTER TABLE "config_evenements" ADD CONSTRAINT "config_evenements_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
