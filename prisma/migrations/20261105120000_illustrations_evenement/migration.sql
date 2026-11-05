-- Photos d'exemple des cases des cadres de la borne, par événement (mémo ILLUSTRATIONS-ADMIN-WEB du 05/11/2026)
CREATE TABLE "illustrations_evenement" (
    "id" SERIAL NOT NULL,
    "config_evenement_id" INTEGER NOT NULL,
    "cible" VARCHAR(10) NOT NULL,
    "forme" VARCHAR(10) NOT NULL,
    "largeur" INTEGER NOT NULL,
    "hauteur" INTEGER NOT NULL,
    "image" BYTEA NOT NULL,
    "vignette" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "illustrations_evenement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "illustrations_evenement_config_evenement_id_idx" ON "illustrations_evenement"("config_evenement_id");

ALTER TABLE "illustrations_evenement" ADD CONSTRAINT "illustrations_evenement_config_evenement_id_fkey" FOREIGN KEY ("config_evenement_id") REFERENCES "config_evenements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
