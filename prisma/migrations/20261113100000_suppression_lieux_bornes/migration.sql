-- Suppression des lieux et des bornes par un super admin : une marque, rien n'est effacé (demande du 13/11/2026)
ALTER TABLE "lieux" ADD COLUMN "supprime_le" TIMESTAMPTZ(3), ADD COLUMN "supprime_par_id" INTEGER;
ALTER TABLE "bornes" ADD COLUMN "supprime_le" TIMESTAMPTZ(3), ADD COLUMN "supprime_par_id" INTEGER;
