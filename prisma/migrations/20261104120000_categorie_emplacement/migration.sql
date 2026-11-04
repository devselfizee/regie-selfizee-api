-- Catégorie des emplacements des concurrents (demande de Sébastien, 03/11/2026) : le même référentiel que le type
-- de lieu des fiches (bar, boîte de nuit…), repris quand un emplacement devient un prospect.
ALTER TABLE "emplacements_concurrents" ADD COLUMN "type_lieu_id" INTEGER;
CREATE INDEX "emplacements_concurrents_type_lieu_id_idx" ON "emplacements_concurrents"("type_lieu_id");
ALTER TABLE "emplacements_concurrents" ADD CONSTRAINT "emplacements_concurrents_type_lieu_id_fkey" FOREIGN KEY ("type_lieu_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Types de lieu fréquents chez les concurrents (aussi ajoutés par le référentiel initial au démarrage)
INSERT INTO "ref_valeurs" ("categorie", "code", "libelle", "ordre") VALUES
  ('TYPE_LIEU', 'BAR', 'Bar', 2),
  ('TYPE_LIEU', 'BOITE_DE_NUIT', 'Boîte de nuit', 1),
  ('TYPE_LIEU', 'FOOD_COURT', 'Halle gourmande / food court', 9),
  ('TYPE_LIEU', 'SALLE_SPECTACLE', 'Salle de concert / spectacle', 10),
  ('TYPE_LIEU', 'HOTEL', 'Hôtel', 11)
ON CONFLICT ("categorie", "code") DO NOTHING;

-- Tcheezebox (cabine) et ses clients repérés sur ses photos Instagram (compte du lieu sur le bord des photos,
-- lieu retrouvé sur Google ; publication du 20/10/2026)
INSERT INTO "concurrents" ("nom", "type_materiel", "site_web", "notes") VALUES
  ('Tcheezebox', 'CABINE', 'https://www.instagram.com/tcheezebox/', 'Lieux retrouvés via les comptes Instagram sur leurs photos')
ON CONFLICT ("nom") DO NOTHING;

INSERT INTO "emplacements_concurrents" ("concurrent_id", "nom", "adresse", "code_postal", "ville", "pays", "latitude", "longitude", "source", "type_lieu_id")
SELECT c."id", v.nom, v.adresse, v.cp, v.ville, 'France', v.lat, v.lng, 'Instagram ' || v.insta, r."id"
FROM (VALUES
  ('Espit Chupitos Montpellier', '8 Rue de la Petite Loge', '34000', 'Montpellier', 43.610441, 3.878073, '@espitchupitos_mtp', 'BAR'),
  ('Espit Chupitos Lyon', '22 Rue Joseph Serlin', '69001', 'Lyon', 45.767646, 4.837259, '@espitchupitoslyon', 'BAR'),
  ('Barberousse Lyon', '18 Rue Terraille', '69001', 'Lyon', 45.768678, 4.835677, '@barberousselyon', 'BAR'),
  ('Barberousse Nantes', '91 Rue du Maréchal Joffre', '44000', 'Nantes', 47.220093, -1.549112, '@barberousse.nantes', 'BAR'),
  ('Bis''Corner', '19 Rue Saint-Paul', '69005', 'Lyon', 45.766344, 4.827074, '@biscornerlyon', 'BAR'),
  ('La Feria', '13 Quai Romain Rolland', '69005', 'Lyon', 45.763509, 4.828946, '@laferialyon', 'BAR'),
  ('Chez Tintin', '4 Rue Octavio Mey', '69005', 'Lyon', 45.766211, 4.828125, '@cheztintinlyon', 'BAR'),
  ('Azar Club', '52 Quai Rambaud', '69002', 'Lyon', 45.735643, 4.815570, '@azarclub', 'BOITE_DE_NUIT'),
  ('Tempête Mini Club et Cocktails', '5 Rue des Couples', '67000', 'Strasbourg', 48.579396, 7.752129, '@tempete_strasbourg', 'BAR'),
  ('Bar Exils', '28 Rue de l''Ail', '67000', 'Strasbourg', 48.579907, 7.748645, '@bar.exils', 'BAR'),
  ('Le Club', '5 Rue du Grand Saint-Jean', '34000', 'Montpellier', 43.605283, 3.875612, '@leclub_montpellier', 'BOITE_DE_NUIT'),
  ('Le Panama Club', '5 Rue de la République', '34000', 'Montpellier', 43.605984, 3.877856, '@panamaclubmontpellier', 'BAR')
) AS v(nom, adresse, cp, ville, lat, lng, insta, type)
JOIN "concurrents" c ON c."nom" = 'Tcheezebox'
LEFT JOIN "ref_valeurs" r ON r."categorie" = 'TYPE_LIEU' AND r."code" = v.type
WHERE NOT EXISTS (SELECT 1 FROM "emplacements_concurrents" e WHERE e."concurrent_id" = c."id");
