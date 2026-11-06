-- CreateEnum
CREATE TYPE "EtatLivraison" AS ENUM ('EN_ATTENTE_MEDIA', 'A_ENVOYER', 'ENVOYE', 'ECHEC');

-- CreateTable
CREATE TABLE "souvenir_inscriptions" (
    "id" UUID NOT NULL,
    "code_event" VARCHAR(8) NOT NULL,
    "photo_uuid" UUID NOT NULL,
    "config_evenement_id" INTEGER,
    "lieu_id" INTEGER,
    "email" TEXT,
    "prenom" TEXT,
    "est_moi" BOOLEAN NOT NULL,
    "optin_lieu" BOOLEAN NOT NULL,
    "optin_selfizee" BOOLEAN NOT NULL,
    "textes" JSONB NOT NULL,
    "ip_tronquee" VARCHAR(64),
    "user_agent" VARCHAR(400),
    "anonymisee_le" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "souvenir_inscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "souvenir_livraisons" (
    "id" BIGSERIAL NOT NULL,
    "inscription_id" UUID NOT NULL,
    "renvoi" BOOLEAN NOT NULL DEFAULT false,
    "etat" "EtatLivraison" NOT NULL,
    "envoye_le" TIMESTAMPTZ(3),
    "erreur" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "souvenir_livraisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "souvenir_cartes" (
    "id" SERIAL NOT NULL,
    "inscription_id" UUID NOT NULL,
    "lot" VARCHAR(8) NOT NULL,
    "code_remise_id" INTEGER,
    "revelee_le" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "souvenir_cartes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "souvenir_liens" (
    "id" SERIAL NOT NULL,
    "jeton_hash" CHAR(64) NOT NULL,
    "email" TEXT NOT NULL,
    "expire_le" TIMESTAMPTZ(3) NOT NULL,
    "ouvert_le" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "souvenir_liens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "souvenir_journal" (
    "id" BIGSERIAL NOT NULL,
    "evenement" VARCHAR(30) NOT NULL,
    "code_event" VARCHAR(8),
    "photo_uuid" UUID,
    "lieu_id" INTEGER,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "souvenir_journal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "souvenir_inscriptions_code_event_photo_uuid_idx" ON "souvenir_inscriptions"("code_event", "photo_uuid");

-- CreateIndex
CREATE INDEX "souvenir_inscriptions_lieu_id_created_at_idx" ON "souvenir_inscriptions"("lieu_id", "created_at");

-- CreateIndex
CREATE INDEX "souvenir_inscriptions_email_idx" ON "souvenir_inscriptions"("email");

-- CreateIndex
CREATE INDEX "souvenir_livraisons_inscription_id_idx" ON "souvenir_livraisons"("inscription_id");

-- CreateIndex
CREATE INDEX "souvenir_livraisons_etat_idx" ON "souvenir_livraisons"("etat");

-- CreateIndex
CREATE UNIQUE INDEX "souvenir_cartes_inscription_id_key" ON "souvenir_cartes"("inscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "souvenir_cartes_code_remise_id_key" ON "souvenir_cartes"("code_remise_id");

-- CreateIndex
CREATE UNIQUE INDEX "souvenir_liens_jeton_hash_key" ON "souvenir_liens"("jeton_hash");

-- CreateIndex
CREATE INDEX "souvenir_liens_expire_le_idx" ON "souvenir_liens"("expire_le");

-- CreateIndex
CREATE INDEX "souvenir_journal_lieu_id_evenement_created_at_idx" ON "souvenir_journal"("lieu_id", "evenement", "created_at");

-- CreateIndex
CREATE INDEX "souvenir_journal_photo_uuid_evenement_idx" ON "souvenir_journal"("photo_uuid", "evenement");

-- AddForeignKey
ALTER TABLE "souvenir_inscriptions" ADD CONSTRAINT "souvenir_inscriptions_config_evenement_id_fkey" FOREIGN KEY ("config_evenement_id") REFERENCES "config_evenements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "souvenir_inscriptions" ADD CONSTRAINT "souvenir_inscriptions_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "souvenir_livraisons" ADD CONSTRAINT "souvenir_livraisons_inscription_id_fkey" FOREIGN KEY ("inscription_id") REFERENCES "souvenir_inscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "souvenir_cartes" ADD CONSTRAINT "souvenir_cartes_inscription_id_fkey" FOREIGN KEY ("inscription_id") REFERENCES "souvenir_inscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "souvenir_cartes" ADD CONSTRAINT "souvenir_cartes_code_remise_id_fkey" FOREIGN KEY ("code_remise_id") REFERENCES "codes_remise"("id") ON DELETE SET NULL ON UPDATE CASCADE;

