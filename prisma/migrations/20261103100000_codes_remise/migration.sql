-- Codes de remise (demande de Sébastien, 02/11/2026) : impressions offertes ou remise en %, générés par lots,
-- saisis sur la borne (API /ingest/v1/codes) ; chaque utilisation est tracée
CREATE TYPE "TypeRemise" AS ENUM ('OFFERT', 'POURCENTAGE');
ALTER TYPE "ImportType" ADD VALUE 'CODES';

CREATE TABLE "lots_codes_remise" (
    "id" SERIAL NOT NULL,
    "libelle" TEXT,
    "type" "TypeRemise" NOT NULL,
    "quantite" INTEGER NOT NULL,
    "pourcentage" INTEGER,
    "lieu_id" INTEGER,
    "seulement_lieu" BOOLEAN NOT NULL DEFAULT false,
    "expire_le" DATE NOT NULL,
    "nb_codes" INTEGER NOT NULL,
    "cree_par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lots_codes_remise_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "lots_codes_remise" ADD CONSTRAINT "lots_codes_remise_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lots_codes_remise" ADD CONSTRAINT "lots_codes_remise_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "codes_remise" (
    "id" SERIAL NOT NULL,
    "code" CHAR(5) NOT NULL,
    "lot_id" INTEGER NOT NULL,
    "utilise" INTEGER NOT NULL DEFAULT 0,
    "desactive_le" TIMESTAMPTZ(3),
    CONSTRAINT "codes_remise_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "codes_remise_code_key" ON "codes_remise"("code");
CREATE INDEX "codes_remise_lot_id_idx" ON "codes_remise"("lot_id");
ALTER TABLE "codes_remise" ADD CONSTRAINT "codes_remise_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots_codes_remise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "utilisations_code_remise" (
    "id" BIGSERIAL NOT NULL,
    "code_id" INTEGER NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "lieu_id" INTEGER,
    "demandees" INTEGER NOT NULL,
    "accordees" INTEGER NOT NULL,
    "utilisation_id" TEXT,
    "horodatage" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "utilisations_code_remise_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "utilisations_code_remise_code_id_idx" ON "utilisations_code_remise"("code_id");
-- Un renvoi de la même utilisation par la borne (réseau coupé) ne décompte pas deux fois
CREATE UNIQUE INDEX "utilisations_code_remise_borne_id_utilisation_id_key" ON "utilisations_code_remise"("borne_id", "utilisation_id");
ALTER TABLE "utilisations_code_remise" ADD CONSTRAINT "utilisations_code_remise_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "codes_remise"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "utilisations_code_remise" ADD CONSTRAINT "utilisations_code_remise_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "utilisations_code_remise" ADD CONSTRAINT "utilisations_code_remise_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;
