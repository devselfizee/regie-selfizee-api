-- Fiche client : le lieu change-t-il lui-même le papier de la borne ? (retour de Sébastien)
ALTER TABLE "lieux" ADD COLUMN "papier_sur_place" BOOLEAN NOT NULL DEFAULT false;
