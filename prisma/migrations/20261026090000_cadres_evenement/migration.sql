-- Cadres dessinés au studio pour les gabarits du kit de la fiche événement (un par gabarit et par lieu)
CREATE TABLE "cadres_evenement" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "gabarit" VARCHAR(20) NOT NULL,
    "nom" TEXT NOT NULL,
    "format_id" VARCHAR(60) NOT NULL,
    "gabarit_studio_id" VARCHAR(60),
    "nb_poses" INTEGER NOT NULL,
    "canvas" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "vignette" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cadres_evenement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cadres_evenement_lieu_id_gabarit_key" ON "cadres_evenement"("lieu_id", "gabarit");

ALTER TABLE "cadres_evenement" ADD CONSTRAINT "cadres_evenement_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
