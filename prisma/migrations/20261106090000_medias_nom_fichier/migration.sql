-- Nom du média avec extension tel que PikCloud le transmet (name_photo du JSON, à défaut fin de media_url) : pour les exports et les requêtes.
-- AlterTable
ALTER TABLE "medias" ADD COLUMN     "nom_fichier" TEXT;

-- Lignes déjà reçues : le nom donné par la borne dans le JSON de séance, sinon la fin du lien PikCloud
UPDATE "medias"
SET "nom_fichier" = COALESCE("brut"->>'name_photo', NULLIF(regexp_replace(split_part("media_url", '?', 1), '^.*/', ''), ''))
WHERE "nom_fichier" IS NULL AND ("brut" IS NOT NULL OR "media_url" IS NOT NULL);
