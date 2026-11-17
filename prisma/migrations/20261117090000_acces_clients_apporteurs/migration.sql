-- Demande du 17/11/2026 : accès client à un ou plusieurs lieux (remplace users.lieu_id), apporteurs d'affaires

-- Accès client : (utilisateur, lieu)
CREATE TABLE "acces_lieux" (
    "user_id" INTEGER NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acces_lieux_pkey" PRIMARY KEY ("user_id","lieu_id")
);
CREATE INDEX "acces_lieux_lieu_id_idx" ON "acces_lieux"("lieu_id");
ALTER TABLE "acces_lieux" ADD CONSTRAINT "acces_lieux_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "acces_lieux" ADD CONSTRAINT "acces_lieux_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Les partenaires déjà rattachés à un lieu gardent leur accès
INSERT INTO "acces_lieux" ("user_id", "lieu_id") SELECT "id", "lieu_id" FROM "users" WHERE "lieu_id" IS NOT NULL;
ALTER TABLE "users" DROP CONSTRAINT "users_lieu_id_fkey";
ALTER TABLE "users" DROP COLUMN "lieu_id";

-- Apporteurs d'affaires : un % des ventes d'un lieu, par apporteur et par lieu
CREATE TABLE "apporteurs_lieux" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "taux_bp" INTEGER NOT NULL,
    "base" "BaseCalcul" NOT NULL DEFAULT 'TTC',
    "net_remboursements" BOOLEAN NOT NULL DEFAULT true,
    "date_debut" DATE NOT NULL,
    "date_fin" DATE,
    "notes" TEXT,
    "cree_par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "apporteurs_lieux_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "apporteurs_lieux_user_id_lieu_id_key" ON "apporteurs_lieux"("user_id", "lieu_id");
CREATE INDEX "apporteurs_lieux_lieu_id_idx" ON "apporteurs_lieux"("lieu_id");
ALTER TABLE "apporteurs_lieux" ADD CONSTRAINT "apporteurs_lieux_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "apporteurs_lieux" ADD CONSTRAINT "apporteurs_lieux_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "apporteurs_lieux" ADD CONSTRAINT "apporteurs_lieux_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
