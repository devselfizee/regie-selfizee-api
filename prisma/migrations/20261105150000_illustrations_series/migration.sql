-- Bibliothèque des séries d'illustrations « type » (mémo ILLUSTRATIONS-ADMIN-WEB § 3a, 05/11/2026)
CREATE TABLE "illustrations_series" (
    "id" SERIAL NOT NULL,
    "nom" VARCHAR(80) NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "illustrations_series_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "illustrations_series_images" (
    "id" SERIAL NOT NULL,
    "serie_id" INTEGER NOT NULL,
    "forme" VARCHAR(10) NOT NULL,
    "largeur" INTEGER NOT NULL,
    "hauteur" INTEGER NOT NULL,
    "image" BYTEA NOT NULL,
    "vignette" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "illustrations_series_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "illustrations_series_images_serie_id_idx" ON "illustrations_series_images"("serie_id");

ALTER TABLE "illustrations_series_images" ADD CONSTRAINT "illustrations_series_images_serie_id_fkey" FOREIGN KEY ("serie_id") REFERENCES "illustrations_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
