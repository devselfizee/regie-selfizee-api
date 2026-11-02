-- Cartes de test (demande de Sébastien) : les ventes payées avec ces cartes (4 derniers chiffres)
-- sont sorties des chiffres réels (agrégats, stats, commissions, exports) et montrées à part
CREATE TABLE "cartes_test" (
    "id" SERIAL NOT NULL,
    "derniers_chiffres" CHAR(4) NOT NULL,
    "nom" TEXT NOT NULL,
    "cree_par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cartes_test_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cartes_test_derniers_chiffres_key" ON "cartes_test"("derniers_chiffres");
ALTER TABLE "cartes_test" ADD CONSTRAINT "cartes_test_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" ADD COLUMN "test" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "transactions_test_idx" ON "transactions"("test") WHERE "test";
