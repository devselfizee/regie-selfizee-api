-- Parc Selfizee ou parc client (location financière) : les stats montrent le parc Selfizee par défaut
CREATE TYPE "Parc" AS ENUM ('SELFIZEE', 'CLIENT');
ALTER TABLE "lieux" ADD COLUMN "parc" "Parc" NOT NULL DEFAULT 'SELFIZEE';
ALTER TABLE "bornes" ADD COLUMN "parc" "Parc" NOT NULL DEFAULT 'SELFIZEE';
