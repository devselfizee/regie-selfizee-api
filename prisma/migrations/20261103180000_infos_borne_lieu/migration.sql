-- Infos du lieu pour la borne (nom affiché, ville, avis et réseaux, assistance), reprises par tous
-- les événements du lieu. Vide : on reprend celles de l'événement par défaut, sinon la fiche du lieu.
ALTER TABLE "lieux" ADD COLUMN "infos_borne" JSONB;
