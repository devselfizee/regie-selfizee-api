-- Emplacements des concurrents vérifiés sur Google Places (demande de Sébastien, 04/11/2026) : le lieu retrouvé, son
-- type, sa note et son nombre d'avis ; la catégorie vient de là, sauf si quelqu'un l'a corrigée à la main.
ALTER TABLE "emplacements_concurrents" ADD COLUMN "categorie_manuelle" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "emplacements_concurrents" ADD COLUMN "google_place_id" TEXT;
ALTER TABLE "emplacements_concurrents" ADD COLUMN "google_nom" TEXT;
ALTER TABLE "emplacements_concurrents" ADD COLUMN "google_type" TEXT;
ALTER TABLE "emplacements_concurrents" ADD COLUMN "google_note" DECIMAL(2,1);
ALTER TABLE "emplacements_concurrents" ADD COLUMN "google_nb_avis" INTEGER;
ALTER TABLE "emplacements_concurrents" ADD COLUMN "google_url" TEXT;
ALTER TABLE "emplacements_concurrents" ADD COLUMN "google_verifie_le" TIMESTAMPTZ(3);
