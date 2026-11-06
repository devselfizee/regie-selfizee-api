-- Réglages de l'application modifiables dans Paramètres (rôles Keycloak, champs du téléphone dans le Hub…)
CREATE TABLE "reglages_application" (
    "cle" TEXT NOT NULL,
    "valeur" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reglages_application_pkey" PRIMARY KEY ("cle")
);

-- Rôles Keycloak vus dans le jeton de chaque compte (dernière connexion) : proposés dans Paramètres
ALTER TABLE "users" ADD COLUMN "roles_jeton" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
