-- Option 2 du 20/11/2026 : comptes clients dans un realm Keycloak « regie » propre à la Régie, regroupés par entreprise

CREATE TYPE "TypeCompte" AS ENUM ('KONITYS', 'REGIE');

CREATE TABLE "entreprises" (
    "id" SERIAL NOT NULL,
    "nom" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "entreprises_pkey" PRIMARY KEY ("id")
);

-- Lieux d'une entreprise
ALTER TABLE "lieux" ADD COLUMN "entreprise_id" INTEGER;
CREATE INDEX "lieux_entreprise_id_idx" ON "lieux"("entreprise_id");
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_entreprise_id_fkey" FOREIGN KEY ("entreprise_id") REFERENCES "entreprises"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Comptes : salarié Konitys (tous les comptes existants) ou client de la Régie ; unicité par sorte de compte
ALTER TABLE "users" ADD COLUMN "compte" "TypeCompte" NOT NULL DEFAULT 'KONITYS';
ALTER TABLE "users" ADD COLUMN "entreprise_id" INTEGER;
ALTER TABLE "users" ADD COLUMN "profil_id" INTEGER;
ALTER TABLE "users" ADD COLUMN "invitation_envoyee_le" TIMESTAMPTZ(3);
DROP INDEX "users_email_key";
DROP INDEX "users_keycloak_sub_key";
CREATE UNIQUE INDEX "users_compte_email_key" ON "users"("compte", "email");
CREATE UNIQUE INDEX "users_compte_keycloak_sub_key" ON "users"("compte", "keycloak_sub");
CREATE INDEX "users_entreprise_id_idx" ON "users"("entreprise_id");
ALTER TABLE "users" ADD CONSTRAINT "users_entreprise_id_fkey" FOREIGN KEY ("entreprise_id") REFERENCES "entreprises"("id") ON DELETE SET NULL ON UPDATE CASCADE;
