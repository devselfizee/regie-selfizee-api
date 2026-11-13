-- Parcours invité, schéma 1.1 (avenant n° 2 du 10/11/2026)
ALTER TABLE "parcours" ADD COLUMN "rendu" TEXT,
ADD COLUMN "offre_fermeture" TEXT,
ADD COLUMN "paiement_passages" JSONB,
ADD COLUMN "upsell_passages" JSONB,
ADD COLUMN "reconstitue" BOOLEAN NOT NULL DEFAULT false;
