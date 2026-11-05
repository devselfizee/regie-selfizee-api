-- Clientèle : tranche « 40-60 ans » avant « Seniors » (retour de Sébastien, 05/11/2026)
INSERT INTO "ref_valeurs" ("categorie", "code", "libelle", "ordre")
SELECT 'CLIENTELE', '40_60', '40-60 ans', COALESCE((SELECT "ordre" FROM "ref_valeurs" WHERE "categorie" = 'CLIENTELE' AND "code" = 'SENIORS'), 99)
ON CONFLICT DO NOTHING;
-- « Seniors » passe juste après
UPDATE "ref_valeurs" SET "ordre" = "ordre" + 1
WHERE "categorie" = 'CLIENTELE' AND "code" = 'SENIORS'
  AND EXISTS (SELECT 1 FROM "ref_valeurs" WHERE "categorie" = 'CLIENTELE' AND "code" = '40_60');
