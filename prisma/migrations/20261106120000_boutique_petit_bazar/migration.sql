-- Type de lieu « Boutique / commerce », et Le Petit Bazar (Uzès), un magasin, rangé dedans
INSERT INTO "ref_valeurs" ("categorie", "code", "libelle", "ordre") VALUES ('TYPE_LIEU', 'BOUTIQUE', 'Boutique / commerce', 13)
ON CONFLICT DO NOTHING;
UPDATE "emplacements_concurrents" e SET "type_lieu_id" = r."id", "categorie_manuelle" = true
FROM "ref_valeurs" r
WHERE r."categorie" = 'TYPE_LIEU' AND r."code" = 'BOUTIQUE'
  AND e."type_lieu_id" IS NULL
  AND upper(btrim(e."nom")) = upper('Le Petit Bazar - Uzès');
