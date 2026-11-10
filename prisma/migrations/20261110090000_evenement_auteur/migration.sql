-- Journal d'événements du lieu : qui a saisi l'événement (retour de Sébastien du 10/11/2026)
ALTER TABLE "evenements_lieu" ADD COLUMN "cree_par_id" INTEGER;
ALTER TABLE "evenements_lieu" ADD COLUMN "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "evenements_lieu" ADD CONSTRAINT "evenements_lieu_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
