-- Lieux d'essai déjà reconnus par leur nom (« test » en mot entier, règle déjà appliquée par l'analyse des lieux) : parc test
UPDATE "lieux" SET "parc" = 'TEST' WHERE NOT "demo" AND ("enseigne" ~* '\mtests?\M' OR "raison_sociale" ~* '\mtests?\M');
