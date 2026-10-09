-- CreateTable
CREATE TABLE "vacances_scolaires" (
    "id" SERIAL NOT NULL,
    "zone" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "annee_scolaire" TEXT NOT NULL,
    "debut" DATE NOT NULL,
    "fin" DATE NOT NULL,

    CONSTRAINT "vacances_scolaires_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meteo_jour" (
    "lieu_id" INTEGER NOT NULL,
    "jour" DATE NOT NULL,
    "temp_max" DOUBLE PRECISION,
    "temp_min" DOUBLE PRECISION,
    "precipitation_mm" DOUBLE PRECISION,
    "code_wmo" INTEGER,
    "prevision" BOOLEAN NOT NULL DEFAULT false,
    "maj_le" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meteo_jour_pkey" PRIMARY KEY ("lieu_id","jour")
);

-- CreateIndex
CREATE UNIQUE INDEX "vacances_scolaires_zone_libelle_annee_scolaire_key" ON "vacances_scolaires"("zone", "libelle", "annee_scolaire");

-- AddForeignKey
ALTER TABLE "meteo_jour" ADD CONSTRAINT "meteo_jour_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
