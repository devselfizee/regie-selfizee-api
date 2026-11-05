-- Médias des séances reçus de PikCloud par le webhook de synchro (contrat PikCloud du 04/11/2026).
-- Une ligne par séance (code_event + filename) ; le JSON et le média ont chacun leur URL et leur état.
-- Les fichiers sont copiés sur le volume MEDIAS_DIR : PikCloud les supprime 90 jours après réception.

-- CreateEnum
CREATE TYPE "FichierStatut" AS ENUM ('ABSENT', 'A_TELECHARGER', 'TELECHARGE', 'ERREUR', 'PURGE');

-- AlterEnum
ALTER TYPE "ImportType" ADD VALUE 'MEDIAS';

-- CreateTable
CREATE TABLE "medias" (
    "id" BIGSERIAL NOT NULL,
    "uuid" UUID NOT NULL,
    "code_event" VARCHAR(8) NOT NULL,
    "filename" TEXT NOT NULL,
    "config_evenement_id" INTEGER,
    "lieu_id" INTEGER,
    "borne_id" INTEGER,
    "borne_identifiant" TEXT NOT NULL,
    "type_media" TEXT NOT NULL,
    "import_id" BIGINT NOT NULL,
    "photo_uuid" UUID,
    "date_photo" TIMESTAMPTZ(3),
    "date_save" TIMESTAMPTZ(3),
    "date_print" TIMESTAMPTZ(3),
    "nb_tirages" INTEGER,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "brut" JSONB,
    "data_url" TEXT,
    "data_statut" "FichierStatut" NOT NULL DEFAULT 'ABSENT',
    "media_url" TEXT,
    "media_statut" "FichierStatut" NOT NULL DEFAULT 'ABSENT',
    "media_chemin" TEXT,
    "vignette_chemin" TEXT,
    "taille_octets" INTEGER,
    "sha256" CHAR(64),
    "tentatives" INTEGER NOT NULL DEFAULT 0,
    "derniere_erreur" TEXT,
    "telecharge_le" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "medias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "medias_uuid_key" ON "medias"("uuid");

-- CreateIndex
CREATE INDEX "medias_config_evenement_id_date_photo_idx" ON "medias"("config_evenement_id", "date_photo");

-- CreateIndex
CREATE INDEX "medias_lieu_id_date_photo_idx" ON "medias"("lieu_id", "date_photo");

-- CreateIndex
CREATE INDEX "medias_photo_uuid_idx" ON "medias"("photo_uuid");

-- CreateIndex
CREATE INDEX "medias_data_statut_idx" ON "medias"("data_statut");

-- CreateIndex
CREATE INDEX "medias_media_statut_idx" ON "medias"("media_statut");

-- CreateIndex
CREATE INDEX "medias_date_save_idx" ON "medias"("date_save");

-- CreateIndex
CREATE UNIQUE INDEX "medias_code_event_filename_key" ON "medias"("code_event", "filename");

-- AddForeignKey
ALTER TABLE "medias" ADD CONSTRAINT "medias_config_evenement_id_fkey" FOREIGN KEY ("config_evenement_id") REFERENCES "config_evenements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medias" ADD CONSTRAINT "medias_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medias" ADD CONSTRAINT "medias_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medias" ADD CONSTRAINT "medias_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "import_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
