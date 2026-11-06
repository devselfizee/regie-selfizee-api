-- AlterEnum
ALTER TYPE "EtatLivraison" ADD VALUE 'PHOTO_INTROUVABLE';

-- AlterTable
ALTER TABLE "souvenir_livraisons" ADD COLUMN     "prochain_essai" TIMESTAMPTZ(3),
ADD COLUMN     "tentatives" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "souvenir_cartes" ADD COLUMN     "mail_envoye_le" TIMESTAMPTZ(3),
ADD COLUMN     "mail_erreur" TEXT,
ADD COLUMN     "mail_prochain_essai" TIMESTAMPTZ(3),
ADD COLUMN     "mail_tentatives" INTEGER NOT NULL DEFAULT 0;

