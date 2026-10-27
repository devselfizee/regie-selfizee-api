-- Parcours invité (avenant du 26/10/2026) : une ligne par séance, vente ou pas
ALTER TYPE "ImportType" ADD VALUE IF NOT EXISTS 'PARCOURS';

CREATE TABLE "parcours" (
    "id" BIGSERIAL NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "parcours_id" TEXT NOT NULL,
    "import_id" BIGINT NOT NULL,
    "lieu_id" INTEGER,
    "affectation_id" INTEGER,
    "evenement" TEXT NOT NULL,
    "kit" TEXT NOT NULL,
    "code_seance" TEXT,
    "photo_uuid" TEXT,
    "debut" TIMESTAMPTZ(3) NOT NULL,
    "fin" TIMESTAMPTZ(3) NOT NULL,
    "jour_local" DATE NOT NULL,
    "heure_locale" INTEGER NOT NULL,
    "duree_s" INTEGER NOT NULL,
    "issue" TEXT NOT NULL,
    "etapes" JSONB NOT NULL,
    "cadre" TEXT,
    "photos" INTEGER NOT NULL,
    "recommencer" INTEGER,
    "couleurs_relances" INTEGER,
    "retours_offre" INTEGER,
    "tirages" INTEGER NOT NULL,
    "paiement_demandes" INTEGER,
    "paiement_statut" TEXT,
    "paiement_montant_cents" INTEGER,
    "upsell_proposes" INTEGER,
    "upsell_acceptes" INTEGER,
    "upsell_montant_cents" INTEGER,
    "appel" BOOLEAN,
    "appel_engagee" BOOLEAN,
    "brut" JSONB NOT NULL,
    "recu_le" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parcours_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "parcours_borne_id_parcours_id_key" ON "parcours"("borne_id", "parcours_id");
CREATE INDEX "parcours_lieu_id_jour_local_idx" ON "parcours"("lieu_id", "jour_local");
CREATE INDEX "parcours_borne_id_debut_idx" ON "parcours"("borne_id", "debut");

ALTER TABLE "parcours" ADD CONSTRAINT "parcours_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "parcours" ADD CONSTRAINT "parcours_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "parcours" ADD CONSTRAINT "parcours_affectation_id_fkey" FOREIGN KEY ("affectation_id") REFERENCES "affectations_borne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "parcours" ADD CONSTRAINT "parcours_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "import_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
