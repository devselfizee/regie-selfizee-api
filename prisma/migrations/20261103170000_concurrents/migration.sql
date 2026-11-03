-- Concurrents (demande de Sébastien, 03/11/2026) : concurrents connus, leurs emplacements (carte des prospects)
-- et, sur la fiche d'un prospect, le concurrent déjà en place.
CREATE TYPE "TypeMateriel" AS ENUM ('CABINE', 'BORNE');

CREATE TABLE "concurrents" (
    "id" SERIAL NOT NULL,
    "nom" TEXT NOT NULL,
    "type_materiel" "TypeMateriel" NOT NULL,
    "site_web" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "concurrents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "concurrents_nom_key" ON "concurrents"("nom");

CREATE TABLE "emplacements_concurrents" (
    "id" SERIAL NOT NULL,
    "concurrent_id" INTEGER NOT NULL,
    "nom" TEXT NOT NULL,
    "adresse" TEXT,
    "code_postal" TEXT,
    "ville" TEXT,
    "pays" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "source" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "emplacements_concurrents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "emplacements_concurrents_concurrent_id_idx" ON "emplacements_concurrents"("concurrent_id");
ALTER TABLE "emplacements_concurrents" ADD CONSTRAINT "emplacements_concurrents_concurrent_id_fkey" FOREIGN KEY ("concurrent_id") REFERENCES "concurrents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lieux" ADD COLUMN "concurrent_en_place" BOOLEAN;
ALTER TABLE "lieux" ADD COLUMN "concurrent_id" INTEGER;
ALTER TABLE "lieux" ADD COLUMN "concurrent_nom" TEXT;
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_concurrent_id_fkey" FOREIGN KEY ("concurrent_id") REFERENCES "concurrents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "concurrents" ("nom", "type_materiel", "site_web") VALUES
  ('Tabobine', 'CABINE', 'https://tabobine.com'),
  ('Triportrait', 'CABINE', NULL);
