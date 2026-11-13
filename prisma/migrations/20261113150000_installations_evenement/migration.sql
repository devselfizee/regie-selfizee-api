-- Mise à jour des événements sur les bornes : ce que chaque borne a téléchargé ou installé (POST /ingest/v1/evenements/installation)
-- CreateEnum
CREATE TYPE "EtatInstallation" AS ENUM ('TELECHARGE', 'INSTALLE', 'ECHEC');
-- CreateTable
CREATE TABLE "installations_evenement" (
    "id" BIGSERIAL NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "config_evenement_id" INTEGER,
    "code" VARCHAR(8) NOT NULL,
    "version" INTEGER NOT NULL,
    "etat" "EtatInstallation" NOT NULL,
    "message" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "installations_evenement_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "installations_evenement_borne_id_created_at_idx" ON "installations_evenement"("borne_id", "created_at");
-- CreateIndex
CREATE INDEX "installations_evenement_config_evenement_id_created_at_idx" ON "installations_evenement"("config_evenement_id", "created_at");
-- AddForeignKey
ALTER TABLE "installations_evenement" ADD CONSTRAINT "installations_evenement_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "installations_evenement" ADD CONSTRAINT "installations_evenement_config_evenement_id_fkey" FOREIGN KEY ("config_evenement_id") REFERENCES "config_evenements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
