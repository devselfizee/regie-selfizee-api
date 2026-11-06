-- SMS des alertes critiques : seulement aux personnes désignées dans la page Utilisateurs (personne par défaut)
ALTER TABLE "users" ADD COLUMN "alertes_sms" BOOLEAN NOT NULL DEFAULT false;
