-- Contraintes non exprimables en Prisma.
-- À ajouter à la fin de la migration initiale (prisma migrate dev --create-only).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Une borne ne peut pas être affectée à deux lieux en même temps (CDC §3.2)
ALTER TABLE affectations_borne
  ADD CONSTRAINT affectations_borne_pas_de_chevauchement
  EXCLUDE USING gist (borne_id WITH =, tstzrange(debut, fin, '[)') WITH &&);

ALTER TABLE affectations_borne
  ADD CONSTRAINT affectations_borne_fin_apres_debut CHECK (fin IS NULL OR fin > debut);

-- Un seul contrat actif à une date donnée pour un lieu
ALTER TABLE contrats_commission
  ADD CONSTRAINT contrats_pas_de_chevauchement
  EXCLUDE USING gist (lieu_id WITH =, daterange(date_effet, date_fin, '[)') WITH &&);

ALTER TABLE lieux ADD CONSTRAINT lieux_visibilite_1_5 CHECK (visibilite BETWEEN 1 AND 5);
ALTER TABLE lieu_horaires ADD CONSTRAINT lieu_horaires_jour_iso CHECK (jour_semaine BETWEEN 1 AND 7);
ALTER TABLE agg_heure ADD CONSTRAINT agg_heure_0_23 CHECK (heure BETWEEN 0 AND 23);
ALTER TABLE transactions ADD CONSTRAINT transactions_montants_positifs
  CHECK (montant_ttc_cents >= 0 AND montant_ht_cents >= 0);
ALTER TABLE contrat_paliers ADD CONSTRAINT contrat_paliers_taux CHECK (taux_bp BETWEEN 0 AND 10000);
