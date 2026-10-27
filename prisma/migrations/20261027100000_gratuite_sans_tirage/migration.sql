-- Avenant ventes n° 2 : séance enregistrée sans tirage ni paiement
ALTER TYPE "Gratuite" ADD VALUE IF NOT EXISTS 'SANS_TIRAGE';
