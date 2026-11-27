-- Codes de remise au nom choisi (« ENZO ») : 3 à 20 caractères au lieu de 5 exactement
ALTER TABLE "codes_remise" ALTER COLUMN "code" SET DATA TYPE VARCHAR(20);
