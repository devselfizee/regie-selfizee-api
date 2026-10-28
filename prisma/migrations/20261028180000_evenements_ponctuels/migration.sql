-- Plusieurs événements de borne par lieu : l'habituel (un seul) et des ponctuels (Halloween, une soirée…)
ALTER TABLE "config_evenements" ADD COLUMN "habituel" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "nom" TEXT;
DROP INDEX "config_evenements_lieu_id_key";
CREATE INDEX "config_evenements_lieu_id_idx" ON "config_evenements"("lieu_id");
CREATE UNIQUE INDEX "config_evenements_un_habituel_par_lieu" ON "config_evenements"("lieu_id") WHERE "habituel";

-- Cadres : rattachés à un événement et à une composition (un même gabarit peut revenir plusieurs fois).
-- Les cadres existants vont à l'événement habituel de leur lieu ; leur composition garde l'id du gabarit.
ALTER TABLE "cadres_evenement" ADD COLUMN "config_evenement_id" INTEGER, ADD COLUMN "composition_id" VARCHAR(40);
UPDATE "cadres_evenement" c SET "config_evenement_id" = e."id", "composition_id" = c."gabarit"
  FROM "config_evenements" e WHERE e."lieu_id" = c."lieu_id" AND e."habituel";
DELETE FROM "cadres_evenement" WHERE "config_evenement_id" IS NULL;
ALTER TABLE "cadres_evenement" ALTER COLUMN "config_evenement_id" SET NOT NULL, ALTER COLUMN "composition_id" SET NOT NULL;
DROP INDEX "cadres_evenement_lieu_id_gabarit_key";
CREATE UNIQUE INDEX "cadres_evenement_config_evenement_id_composition_id_key" ON "cadres_evenement"("config_evenement_id", "composition_id");
CREATE INDEX "cadres_evenement_lieu_id_idx" ON "cadres_evenement"("lieu_id");
ALTER TABLE "cadres_evenement" ADD CONSTRAINT "cadres_evenement_config_evenement_id_fkey" FOREIGN KEY ("config_evenement_id") REFERENCES "config_evenements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
