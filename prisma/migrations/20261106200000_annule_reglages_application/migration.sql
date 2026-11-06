-- Retour aux variables d'environnement pour les rôles Keycloak et le téléphone : la table de réglages et les rôles du jeton
-- (migration 20261106190000, retirée) ne servent plus. Sans effet si elle n'avait pas été appliquée.
DROP TABLE IF EXISTS "reglages_application";
ALTER TABLE "users" DROP COLUMN IF EXISTS "roles_jeton";
