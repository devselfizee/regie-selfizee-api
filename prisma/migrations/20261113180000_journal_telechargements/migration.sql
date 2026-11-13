-- Journal des téléchargements d'événements : étapes DEMANDE et ENVOYE, déclencheur (auto / manuel), lieu copié, index pour la lecture par curseur
-- CreateEnum
CREATE TYPE "Declencheur" AS ENUM ('AUTO', 'MANUEL');
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "EtatInstallation" ADD VALUE 'DEMANDE';
ALTER TYPE "EtatInstallation" ADD VALUE 'ENVOYE';
-- DropIndex
DROP INDEX "installations_evenement_borne_id_created_at_idx";
-- DropIndex
DROP INDEX "installations_evenement_config_evenement_id_created_at_idx";
-- AlterTable
ALTER TABLE "installations_evenement" ADD COLUMN     "declencheur" "Declencheur",
ADD COLUMN     "lieu_id" INTEGER;
-- CreateIndex
CREATE INDEX "installations_evenement_borne_id_id_idx" ON "installations_evenement"("borne_id", "id");
-- CreateIndex
CREATE INDEX "installations_evenement_lieu_id_id_idx" ON "installations_evenement"("lieu_id", "id");
-- CreateIndex
CREATE INDEX "installations_evenement_config_evenement_id_id_idx" ON "installations_evenement"("config_evenement_id", "id");
-- CreateIndex
CREATE INDEX "installations_evenement_created_at_idx" ON "installations_evenement"("created_at");
