-- Profils Konitys de chaque compte (Admin Panel), relevés à sa connexion : affichés dans la page Utilisateurs
ALTER TABLE "users" ADD COLUMN "profils_hub" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "users" ADD COLUMN "admin_plateforme" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "profils_releves_le" TIMESTAMPTZ(3);
