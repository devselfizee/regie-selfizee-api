-- Avenant ventes n° 4 (13/11/2026) : codes jusqu'à 32 caractères, utilisation exacte du code pour la vente
ALTER TABLE "transactions" ALTER COLUMN "code_remise" TYPE VARCHAR(32);
ALTER TABLE "transactions" ADD COLUMN "code_utilisation_id" VARCHAR(128);
