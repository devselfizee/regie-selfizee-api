-- Antenne Selfizee qui suit le lieu (liste administrable ANTENNE)
ALTER TYPE "RefCategorie" ADD VALUE IF NOT EXISTS 'ANTENNE';
ALTER TABLE "lieux" ADD COLUMN "antenne_id" INTEGER;
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_antenne_id_fkey" FOREIGN KEY ("antenne_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "lieux_antenne_id_idx" ON "lieux"("antenne_id");
