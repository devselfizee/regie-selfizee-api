-- CreateEnum
CREATE TYPE "Encaissement" AS ENUM ('CONFIRME', 'INCERTAIN');

-- CreateEnum
CREATE TYPE "MotifStatut" AS ENUM ('INVITE', 'BANQUE', 'TERMINAL');

-- CreateEnum
CREATE TYPE "Gratuite" AS ENUM ('MODE_GRATUIT', 'CODE_STAFF', 'DEGRADE', 'REIMPRESSION');

-- AlterEnum
ALTER TYPE "ImportSource" ADD VALUE 'BACKOFFICE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MoyenPaiement" ADD VALUE 'WEB';
ALTER TYPE "MoyenPaiement" ADD VALUE 'AUCUN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionStatut" ADD VALUE 'EXPIREE';
ALTER TYPE "TransactionStatut" ADD VALUE 'OFFERTE';

-- AlterTable
ALTER TABLE "agg_jour" ADD COLUMN     "ca_incertain_ttc_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nb_expirees" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nb_gratuites" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nb_incertaines" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nb_offertes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tirages_non_factures" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "encaissement" "Encaissement",
ADD COLUMN     "gratuite" "Gratuite",
ADD COLUMN     "motif" "MotifStatut",
ADD COLUMN     "pikcloud_uuid" UUID,
ADD COLUMN     "reference_sequence" TEXT;

-- Cohérence (schéma 1.1) : l'encaissement ne concerne que les ventes acceptées, une gratuité est à 0 €
ALTER TABLE transactions ADD CONSTRAINT transactions_encaissement_acceptee CHECK (encaissement IS NULL OR statut = 'ACCEPTEE');
ALTER TABLE transactions ADD CONSTRAINT transactions_gratuite_zero CHECK (gratuite IS NULL OR montant_ttc_cents = 0);
