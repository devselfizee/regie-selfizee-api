-- Médias supprimés : la raison (RGPD = demande de l'invité, CONSERVATION = durée dépassée) et la date, affichées dans la galerie
-- AlterTable
ALTER TABLE "medias" ADD COLUMN     "purge_le" TIMESTAMPTZ(3),
ADD COLUMN     "purge_motif" VARCHAR(12);
