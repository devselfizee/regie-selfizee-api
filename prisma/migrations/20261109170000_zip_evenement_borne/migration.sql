-- AlterEnum
ALTER TYPE "ImportType" ADD VALUE 'CONFIG';

-- AlterTable
ALTER TABLE "config_evenements" ADD COLUMN     "zip_chemin" TEXT,
ADD COLUMN     "zip_sha256" CHAR(64),
ADD COLUMN     "zip_taille" INTEGER;

