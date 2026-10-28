-- Journal des bornes : ventes déjà reçues complétées par un renvoi (avenant ventes n° 3)
ALTER TABLE "import_lots" ADD COLUMN "nb_completees" INTEGER NOT NULL DEFAULT 0;
