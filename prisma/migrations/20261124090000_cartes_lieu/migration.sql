-- Cartes sans contact du lieu (Mifare), avenant du 23/11/2026 (docs/avenant-cartes-lieu.md)

ALTER TYPE "ImportType" ADD VALUE 'CARTES';

CREATE TYPE "EffetCarteLieu" AS ENUM ('DEBITE', 'OFFERT');

CREATE TABLE "cartes_lieu" (
    "id" SERIAL NOT NULL,
    "uid" VARCHAR(20) NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "libelle" TEXT,
    "effet" "EffetCarteLieu" NOT NULL,
    "solde_cents" INTEGER NOT NULL DEFAULT 0,
    "plafond_jour_cents" INTEGER,
    "plafond_jour_tirages" INTEGER,
    "expire_le" DATE,
    "desactive_le" TIMESTAMPTZ(3),
    "notes" TEXT,
    "cree_par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "cartes_lieu_pkey" PRIMARY KEY ("id"),
    -- Le solde ne descend jamais sous zéro (pas de débit partiel, retraits limités au solde)
    CONSTRAINT "cartes_lieu_solde_positif" CHECK ("solde_cents" >= 0)
);
CREATE UNIQUE INDEX "cartes_lieu_uid_key" ON "cartes_lieu"("uid");
CREATE INDEX "cartes_lieu_lieu_id_idx" ON "cartes_lieu"("lieu_id");
ALTER TABLE "cartes_lieu" ADD CONSTRAINT "cartes_lieu_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cartes_lieu" ADD CONSTRAINT "cartes_lieu_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "utilisations_carte_lieu" (
    "id" BIGSERIAL NOT NULL,
    "carte_id" INTEGER,
    "uid" VARCHAR(20),
    "type_carte" VARCHAR(2),
    "borne_id" INTEGER NOT NULL,
    "lieu_id" INTEGER,
    "utilisation_id" VARCHAR(128) NOT NULL,
    "montant_cents" INTEGER NOT NULL,
    "nb" INTEGER NOT NULL,
    "session_code" VARCHAR(32),
    "evenement_code" VARCHAR(16),
    "accepte" BOOLEAN NOT NULL,
    "effet" "EffetCarteLieu",
    "montant_debite_cents" INTEGER NOT NULL DEFAULT 0,
    "solde_apres_cents" INTEGER,
    "raison" VARCHAR(32),
    "annulee_le" TIMESTAMPTZ(3),
    "annulation_raison" VARCHAR(32),
    "horodatage" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "utilisations_carte_lieu_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "utilisations_carte_lieu_borne_id_utilisation_id_key" ON "utilisations_carte_lieu"("borne_id", "utilisation_id");
CREATE INDEX "utilisations_carte_lieu_carte_id_horodatage_idx" ON "utilisations_carte_lieu"("carte_id", "horodatage");
CREATE INDEX "utilisations_carte_lieu_uid_idx" ON "utilisations_carte_lieu"("uid");
ALTER TABLE "utilisations_carte_lieu" ADD CONSTRAINT "utilisations_carte_lieu_carte_id_fkey" FOREIGN KEY ("carte_id") REFERENCES "cartes_lieu"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "utilisations_carte_lieu" ADD CONSTRAINT "utilisations_carte_lieu_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "utilisations_carte_lieu" ADD CONSTRAINT "utilisations_carte_lieu_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "mouvements_carte_lieu" (
    "id" SERIAL NOT NULL,
    "carte_id" INTEGER NOT NULL,
    "montant_cents" INTEGER NOT NULL,
    "solde_apres_cents" INTEGER NOT NULL,
    "note" TEXT,
    "par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mouvements_carte_lieu_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mouvements_carte_lieu_carte_id_created_at_idx" ON "mouvements_carte_lieu"("carte_id", "created_at");
ALTER TABLE "mouvements_carte_lieu" ADD CONSTRAINT "mouvements_carte_lieu_carte_id_fkey" FOREIGN KEY ("carte_id") REFERENCES "cartes_lieu"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mouvements_carte_lieu" ADD CONSTRAINT "mouvements_carte_lieu_par_id_fkey" FOREIGN KEY ("par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Vente payée ou offerte par une carte du lieu : l'utilisation exacte
ALTER TABLE "transactions" ADD COLUMN "carte_utilisation_id" VARCHAR(128);
