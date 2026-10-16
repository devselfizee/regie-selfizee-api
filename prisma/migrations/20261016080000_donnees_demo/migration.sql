-- Données de démonstration : marquées pour être effacées sans toucher aux vraies
ALTER TABLE "lieux" ADD COLUMN "demo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bornes" ADD COLUMN "demo" BOOLEAN NOT NULL DEFAULT false;
