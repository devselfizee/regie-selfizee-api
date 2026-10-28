-- Suivi de la fiche lieu : commentaires de l'équipe et mentions (demande de Sébastien)
CREATE TABLE "commentaires_lieu" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "auteur_id" INTEGER,
    "texte" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifie_le" TIMESTAMPTZ(3),
    CONSTRAINT "commentaires_lieu_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "commentaires_lieu_lieu_id_created_at_idx" ON "commentaires_lieu"("lieu_id", "created_at");
ALTER TABLE "commentaires_lieu" ADD CONSTRAINT "commentaires_lieu_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commentaires_lieu" ADD CONSTRAINT "commentaires_lieu_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "mentions_commentaire" (
    "commentaire_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "lu_le" TIMESTAMPTZ(3),
    CONSTRAINT "mentions_commentaire_pkey" PRIMARY KEY ("commentaire_id", "user_id")
);
CREATE INDEX "mentions_commentaire_user_id_lu_le_idx" ON "mentions_commentaire"("user_id", "lu_le");
ALTER TABLE "mentions_commentaire" ADD CONSTRAINT "mentions_commentaire_commentaire_id_fkey" FOREIGN KEY ("commentaire_id") REFERENCES "commentaires_lieu"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mentions_commentaire" ADD CONSTRAINT "mentions_commentaire_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
