-- Retour de Sébastien : une borne n'a qu'un identifiant (celui qu'elle envoie) ; le n° de série faisait doublon.
-- Le n° de série du module de paiement (modules_paiement.numero_serie) est conservé.
DROP INDEX IF EXISTS "bornes_numero_serie_key";
ALTER TABLE "bornes" DROP COLUMN "numero_serie";
