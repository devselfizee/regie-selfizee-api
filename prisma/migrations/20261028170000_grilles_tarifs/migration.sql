-- Tarifs en trois niveaux (demande de Sébastien) : base du parc, puis tarifs par défaut d'un lieu
CREATE TABLE "grilles_tarifs" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER,
    "grille" JSONB NOT NULL,
    "maj_par_id" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "grilles_tarifs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "grilles_tarifs_lieu_id_key" ON "grilles_tarifs"("lieu_id");
-- Une seule grille de base (lieu_id nul)
CREATE UNIQUE INDEX "grilles_tarifs_base_unique" ON "grilles_tarifs"((lieu_id IS NULL)) WHERE lieu_id IS NULL;
ALTER TABLE "grilles_tarifs" ADD CONSTRAINT "grilles_tarifs_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "grilles_tarifs" ADD CONSTRAINT "grilles_tarifs_maj_par_id_fkey" FOREIGN KEY ("maj_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
