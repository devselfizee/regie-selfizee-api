-- Adresses e-mail tapées sur la borne (shareWithOthers, docs/avenant-synchro-adresses-borne.md) : inscriptions d'origine BORNE,
-- une seule par adresse et par photo. photo_uuid passe en texte : le logiciel 2.0 de la borne envoie une empreinte de 64
-- hexadécimaux au lieu d'un UUID. numerique_seul : achat numérique sans tirage (digital_only).


-- CreateEnum
CREATE TYPE "OrigineInscription" AS ENUM ('PAGE', 'BORNE');

-- AlterTable
ALTER TABLE "medias" ADD COLUMN     "numerique_seul" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "photo_uuid" SET DATA TYPE VARCHAR(64) USING "photo_uuid"::text;

-- AlterTable
ALTER TABLE "souvenir_inscriptions" ADD COLUMN     "origine" "OrigineInscription" NOT NULL DEFAULT 'PAGE',
ALTER COLUMN "photo_uuid" SET DATA TYPE VARCHAR(64) USING "photo_uuid"::text;

-- AlterTable
ALTER TABLE "souvenir_journal" ALTER COLUMN "photo_uuid" SET DATA TYPE VARCHAR(64) USING "photo_uuid"::text;

-- CreateIndex
CREATE UNIQUE INDEX "souvenir_inscriptions_code_event_photo_uuid_email_key" ON "souvenir_inscriptions"("code_event", "photo_uuid", "email");

