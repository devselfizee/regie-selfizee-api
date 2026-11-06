-- Rôle tenu dans Keycloak (source unique) : vrai quand le jeton de la dernière connexion portait un rôle de la Régie
ALTER TABLE "users" ADD COLUMN "role_keycloak" BOOLEAN NOT NULL DEFAULT false;
