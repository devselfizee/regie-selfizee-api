-- Photos d'illustration du client, reprises par tous les événements du lieu (maquettes du 10/11/2026)
CREATE TABLE "illustrations_lieu" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "forme" VARCHAR(10) NOT NULL,
    "largeur" INTEGER NOT NULL,
    "hauteur" INTEGER NOT NULL,
    "image" BYTEA NOT NULL,
    "vignette" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "illustrations_lieu_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "illustrations_lieu_lieu_id_idx" ON "illustrations_lieu"("lieu_id");

ALTER TABLE "illustrations_lieu" ADD CONSTRAINT "illustrations_lieu_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
