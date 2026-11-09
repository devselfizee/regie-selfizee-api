-- Fiche lieu (retour de Sébastien) : où sont les clés (texte et photos), quand joindre les contacts
ALTER TABLE "lieux" ADD COLUMN "localisation_cles" TEXT;
ALTER TABLE "lieux" ADD COLUMN "disponibilite_contacts" TEXT;

CREATE TABLE "lieu_photos_cles" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "legende" TEXT,
    "largeur" INTEGER NOT NULL,
    "hauteur" INTEGER NOT NULL,
    "image" BYTEA NOT NULL,
    "vignette" BYTEA NOT NULL,
    "cree_par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lieu_photos_cles_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lieu_photos_cles_lieu_id_idx" ON "lieu_photos_cles"("lieu_id");
ALTER TABLE "lieu_photos_cles" ADD CONSTRAINT "lieu_photos_cles_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lieu_photos_cles" ADD CONSTRAINT "lieu_photos_cles_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
