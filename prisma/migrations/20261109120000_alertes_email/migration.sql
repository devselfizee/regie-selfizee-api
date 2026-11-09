-- E-mails des alertes et récapitulatif quotidien : aux personnes désignées dans la page Utilisateurs
-- (les droits viennent désormais de l'Admin Panel, le rôle de la Régie ne sert plus à choisir les destinataires).
ALTER TABLE "users" ADD COLUMN "alertes_email" BOOLEAN NOT NULL DEFAULT false;
-- Rien ne change à la bascule : ceux qui les recevaient (admins, techniciens) restent abonnés
UPDATE "users" SET "alertes_email" = true WHERE "is_active" AND "role" IN ('ADMIN', 'TECHNICIEN') AND "email" <> 'dev@local';
