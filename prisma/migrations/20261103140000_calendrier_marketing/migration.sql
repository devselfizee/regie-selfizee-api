-- Calendrier marketing (demande de Sébastien, 02/11/2026) : temps forts commerciaux affichés sur les courbes de CA,
-- un jour (par défaut) ou une période ; « annuel » : même jour chaque année (Saint-Valentin, Halloween…).
CREATE TABLE "evenements_marketing" (
    "id" SERIAL NOT NULL,
    "nom" TEXT NOT NULL,
    "debut" DATE NOT NULL,
    "fin" DATE NOT NULL,
    "annuel" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evenements_marketing_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "evenements_marketing_debut_idx" ON "evenements_marketing"("debut");

-- Calendrier de départ (modifiable dans Paramètres → Calendrier marketing)
INSERT INTO "evenements_marketing" ("nom", "debut", "fin", "annuel") VALUES
  ('Saint-Valentin', '2026-02-14', '2026-02-14', true),
  ('Saint-Patrick', '2026-03-17', '2026-03-17', true),
  ('Fête de la musique', '2026-06-21', '2026-06-21', true),
  ('Halloween', '2026-10-31', '2026-10-31', true),
  ('Saint-Sylvestre', '2026-12-31', '2026-12-31', true),
  ('Fête des mères', '2025-05-25', '2025-05-25', false),
  ('Fête des mères', '2026-05-31', '2026-05-31', false),
  ('Fête des mères', '2027-05-30', '2027-05-30', false),
  ('Fête des pères', '2025-06-15', '2025-06-15', false),
  ('Fête des pères', '2026-06-21', '2026-06-21', false),
  ('Fête des pères', '2027-06-20', '2027-06-20', false),
  ('Rentrée des classes', '2025-09-01', '2025-09-01', false),
  ('Rentrée des classes', '2026-09-01', '2026-09-01', false),
  ('Rentrée des classes', '2027-09-01', '2027-09-01', false),
  ('Coupe du monde de football', '2026-06-11', '2026-07-19', false);
