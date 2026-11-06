-- Identifiant de l'utilisateur sur la plateforme Konitys (relevé à la connexion) : destinataire des notifications de la cloche
ALTER TABLE "users" ADD COLUMN "plateforme_user_id" INTEGER;
