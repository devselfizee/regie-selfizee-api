-- Avenant du 24/11/2026 (équipe borne) : événement booth « sur mesure ». L'exploitant dépose dans la Régie le zip d'un
-- événement booth ; la Régie le sert aux bornes comme un de ses événements. Une ligne par code booth (tous ses
-- créneaux, tous lieux) ; version = compteur des dépôts, jamais remis à zéro ; actif = case « Événement sur mesure ».

-- CreateTable
CREATE TABLE "zips_booth" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "actif" BOOLEAN NOT NULL DEFAULT false,
    "publiee_le" TIMESTAMPTZ(3),
    "zip_chemin" TEXT,
    "zip_taille" INTEGER,
    "zip_sha256" CHAR(64),
    "nom_fichier" VARCHAR(255),
    "depose_par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "zips_booth_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "zips_booth_code_key" ON "zips_booth"("code");
-- AddForeignKey
ALTER TABLE "zips_booth" ADD CONSTRAINT "zips_booth_depose_par_id_fkey" FOREIGN KEY ("depose_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
