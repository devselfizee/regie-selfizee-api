-- Avenant du 18/11/2026 (équipe borne) : créneaux d'événements booth programmés sur un lieu. La Régie garde le
-- code saisi et ses dates, sans réglages ni zip ; le programme de la borne le transmet avec origine « booth »,
-- version 0 et status « complete ». Le même code peut être programmé sur plusieurs lieux (pas d'unicité).

-- CreateTable
CREATE TABLE "evenements_booth" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "nom" VARCHAR(80),
    "date_debut" DATE NOT NULL,
    "date_fin" DATE NOT NULL,
    "heure_debut" VARCHAR(5),
    "heure_fin" VARCHAR(5),
    "cree_par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "evenements_booth_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "evenements_booth_lieu_id_date_debut_idx" ON "evenements_booth"("lieu_id", "date_debut");
-- AddForeignKey
ALTER TABLE "evenements_booth" ADD CONSTRAINT "evenements_booth_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "evenements_booth" ADD CONSTRAINT "evenements_booth_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
