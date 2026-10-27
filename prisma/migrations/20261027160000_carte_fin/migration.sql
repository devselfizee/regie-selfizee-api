-- Avenant ventes n° 2 : 4 derniers chiffres de la carte (ticket du terminal), décision de Selfizee du 27/10/2026
ALTER TABLE "transactions" ADD COLUMN "carte_fin" CHAR(4);
