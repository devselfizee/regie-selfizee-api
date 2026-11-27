-- Demande de Sébastien du 26/11/2026 : privatisations d'un lieu. Forfait vendu au lieu (ou offert) pour un événement où
-- la borne passe en gratuit ; compte dans le CA du lieu, à part des ventes d'impression, en entier le jour du début.
-- Montant saisi HT, TTC calculé avec le taux de TVA (points de base : 2000 = 20 %).

-- CreateTable
CREATE TABLE "privatisations" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "libelle" VARCHAR(200) NOT NULL,
    "debut" DATE NOT NULL,
    "fin" DATE NOT NULL,
    "offerte" BOOLEAN NOT NULL DEFAULT false,
    "montant_ht_cents" INTEGER NOT NULL,
    "taux_tva_bp" INTEGER NOT NULL DEFAULT 2000,
    "montant_ttc_cents" INTEGER NOT NULL,
    "papier_inclus" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "cree_par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "privatisations_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "privatisations_lieu_id_debut_idx" ON "privatisations"("lieu_id", "debut");
-- CreateIndex
CREATE INDEX "privatisations_debut_idx" ON "privatisations"("debut");
-- AddForeignKey
ALTER TABLE "privatisations" ADD CONSTRAINT "privatisations_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "privatisations" ADD CONSTRAINT "privatisations_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
