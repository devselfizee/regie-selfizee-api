-- Emplacement d'un concurrent transformé en prospect (demande de Sébastien) : la fiche créée, pour ne pas la recréer
ALTER TABLE "emplacements_concurrents" ADD COLUMN "lieu_id" INTEGER;
CREATE UNIQUE INDEX "emplacements_concurrents_lieu_id_key" ON "emplacements_concurrents"("lieu_id");
ALTER TABLE "emplacements_concurrents" ADD CONSTRAINT "emplacements_concurrents_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;
