-- Mails paramétrables dans la Régie (Paramètres → E-mails RGPD) : lien d'accès aux données, notification interne
-- CreateTable
CREATE TABLE "modeles_mail" (
    "cle" VARCHAR(40) NOT NULL,
    "sujet" VARCHAR(200) NOT NULL,
    "corps" TEXT NOT NULL,
    "destinataires" VARCHAR(500),
    "modifie_par_id" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "modeles_mail_pkey" PRIMARY KEY ("cle")
);

-- AddForeignKey
ALTER TABLE "modeles_mail" ADD CONSTRAINT "modeles_mail_modifie_par_id_fkey" FOREIGN KEY ("modifie_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

