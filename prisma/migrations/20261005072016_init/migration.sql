-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'COMMERCIAL', 'TECHNICIEN', 'PARTENAIRE');

-- CreateEnum
CREATE TYPE "RefCategorie" AS ENUM ('TYPE_LIEU', 'SOUS_TYPE_LIEU', 'STANDING', 'CLIENTELE', 'ZONE_GEO', 'TAILLE_COMMUNE', 'EMPLACEMENT_ZONE', 'ECLAIRAGE', 'ORIGINE_LEAD', 'TYPE_EVENEMENT');

-- CreateEnum
CREATE TYPE "LieuStatut" AS ENUM ('PROSPECT', 'ACTIF', 'SUSPENDU', 'RESILIE');

-- CreateEnum
CREATE TYPE "Saisonnalite" AS ENUM ('ANNUEL', 'SAISONNIER');

-- CreateEnum
CREATE TYPE "InterieurExterieur" AS ENUM ('INTERIEUR', 'EXTERIEUR', 'MIXTE');

-- CreateEnum
CREATE TYPE "ContactRole" AS ENUM ('GERANT', 'REFERENT_SUR_PLACE', 'COMPTABILITE', 'AUTRE');

-- CreateEnum
CREATE TYPE "BorneStatut" AS ENUM ('EN_STOCK', 'INSTALLEE', 'EN_PANNE', 'EN_REPARATION', 'REFORMEE');

-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('API', 'DEPOT_FICHIER', 'RATTRAPAGE_MANUEL');

-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('TRANSACTIONS', 'HEARTBEAT', 'RELEVE_MONETIQUE');

-- CreateEnum
CREATE TYPE "ImportStatut" AS ENUM ('OK', 'PARTIEL', 'REJETE');

-- CreateEnum
CREATE TYPE "ImportErreurStatut" AS ENUM ('NOUVELLE', 'RETRAITEE', 'IGNOREE');

-- CreateEnum
CREATE TYPE "TransactionStatut" AS ENUM ('ACCEPTEE', 'REFUSEE', 'ANNULEE', 'REMBOURSEE');

-- CreateEnum
CREATE TYPE "MoyenPaiement" AS ENUM ('CB', 'SANS_CONTACT', 'ESPECES', 'MOBILE', 'AUTRE');

-- CreateEnum
CREATE TYPE "RapprochementStatut" AS ENUM ('NON_RAPPROCHE', 'RAPPROCHE', 'ECART', 'NON_APPLICABLE');

-- CreateEnum
CREATE TYPE "ModeleCommission" AS ENUM ('AUCUNE', 'POURCENTAGE', 'POURCENTAGE_APRES_SEUIL', 'PALIERS', 'FORFAIT');

-- CreateEnum
CREATE TYPE "BaseCalcul" AS ENUM ('TTC', 'HT');

-- CreateEnum
CREATE TYPE "Periodicite" AS ENUM ('MOIS', 'TRIMESTRE', 'SAISON', 'ANNEE');

-- CreateEnum
CREATE TYPE "SeuilMode" AS ENUM ('AU_DELA', 'DES_ATTEINTE');

-- CreateEnum
CREATE TYPE "SeuilCumul" AS ENUM ('PAR_PERIODE', 'CUMULE');

-- CreateEnum
CREATE TYPE "PaliersMode" AS ENUM ('MARGINAL', 'GLOBAL');

-- CreateEnum
CREATE TYPE "ReversementStatut" AS ENUM ('A_CALCULER', 'CALCULE', 'VALIDE', 'FACTURE_PAR_LIEU', 'AUTOFACTURE', 'PAYE');

-- CreateEnum
CREATE TYPE "TypeAlerte" AS ENUM ('BAISSE_CA', 'ZERO_VENTE', 'BORNE_MUETTE', 'TAUX_REFUS', 'PIC_SUSPECT', 'VENTE_HORS_HORAIRES', 'CONSOMMABLES', 'BORNE_NON_AFFECTEE', 'ECART_RAPPROCHEMENT');

-- CreateEnum
CREATE TYPE "NiveauAlerte" AS ENUM ('INFO', 'WARNING', 'CRITIQUE');

-- CreateEnum
CREATE TYPE "AlerteStatut" AS ENUM ('NOUVELLE', 'PRISE_EN_CHARGE', 'RESOLUE', 'IGNOREE');

-- CreateEnum
CREATE TYPE "CanalNotif" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "CategorieCout" AS ENUM ('CONSOMMABLES', 'DEPLACEMENT', 'INTERVENTION', 'PIECE', 'AUTRE');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "keycloak_sub" TEXT,
    "crm_id" INTEGER,
    "email" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "prenom" TEXT NOT NULL,
    "telephone" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'COMMERCIAL',
    "lieu_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ref_valeurs" (
    "id" SERIAL NOT NULL,
    "categorie" "RefCategorie" NOT NULL,
    "code" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "ordre" INTEGER NOT NULL DEFAULT 0,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "parent_id" INTEGER,

    CONSTRAINT "ref_valeurs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lieux" (
    "id" SERIAL NOT NULL,
    "crm_client_id" INTEGER,
    "statut" "LieuStatut" NOT NULL DEFAULT 'ACTIF',
    "raison_sociale" TEXT NOT NULL,
    "enseigne" TEXT NOT NULL,
    "siret" CHAR(14),
    "adresse" TEXT,
    "code_postal" TEXT,
    "ville" TEXT,
    "pays" CHAR(2) NOT NULL DEFAULT 'FR',
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "type_lieu_id" INTEGER NOT NULL,
    "sous_type_id" INTEGER,
    "standing_id" INTEGER,
    "saisonnalite" "Saisonnalite" NOT NULL DEFAULT 'ANNUEL',
    "capacite_accueil" INTEGER,
    "frequentation_jour" INTEGER,
    "frequentation_semaine" INTEGER,
    "zone_geo_id" INTEGER,
    "taille_commune_id" INTEGER,
    "concurrence_photo" BOOLEAN,
    "concurrence_photo_notes" TEXT,
    "interieur_exterieur" "InterieurExterieur",
    "emplacement_zone_id" INTEGER,
    "visibilite" INTEGER,
    "eclairage_id" INTEGER,
    "date_signature" DATE,
    "date_installation" DATE,
    "duree_contrat_mois" INTEGER,
    "commercial_id" INTEGER,
    "origine_lead_id" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lieux_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lieu_contacts" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "role" "ContactRole" NOT NULL,
    "nom" TEXT NOT NULL,
    "prenom" TEXT,
    "email" TEXT,
    "telephone" TEXT,

    CONSTRAINT "lieu_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lieu_clienteles" (
    "lieu_id" INTEGER NOT NULL,
    "ref_valeur_id" INTEGER NOT NULL,

    CONSTRAINT "lieu_clienteles_pkey" PRIMARY KEY ("lieu_id","ref_valeur_id")
);

-- CreateTable
CREATE TABLE "lieu_horaires" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "jour_semaine" INTEGER NOT NULL,
    "ouverture" TIME(0) NOT NULL,
    "fermeture" TIME(0) NOT NULL,
    "saison_id" INTEGER,

    CONSTRAINT "lieu_horaires_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lieu_saisons" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "libelle" TEXT,
    "debut" DATE NOT NULL,
    "fin" DATE NOT NULL,

    CONSTRAINT "lieu_saisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lieu_fermetures" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "debut" DATE NOT NULL,
    "fin" DATE NOT NULL,
    "motif" TEXT,

    CONSTRAINT "lieu_fermetures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gammes" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "gammes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "types_module_paiement" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "fournisseur" TEXT,
    "rapprochable" BOOLEAN NOT NULL DEFAULT false,
    "actif" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "types_module_paiement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modules_paiement" (
    "id" SERIAL NOT NULL,
    "type_id" INTEGER NOT NULL,
    "borne_id" INTEGER,
    "numero_serie" TEXT,
    "identifiant_prestataire" TEXT,
    "installe_le" DATE,
    "retire_le" DATE,

    CONSTRAINT "modules_paiement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bornes" (
    "id" SERIAL NOT NULL,
    "identifiant" TEXT NOT NULL,
    "gamme_id" INTEGER NOT NULL,
    "numero_serie" TEXT NOT NULL,
    "crm_id" INTEGER,
    "statut" "BorneStatut" NOT NULL DEFAULT 'EN_STOCK',
    "api_key_hash" TEXT,
    "api_key_prefix" TEXT,
    "api_key_cree_le" TIMESTAMPTZ(3),
    "logiciel_version" TEXT,
    "dernier_heartbeat" TIMESTAMPTZ(3),
    "derniere_vente" TIMESTAMPTZ(3),
    "cout_achat_cents" INTEGER,
    "duree_amortissement_mois" INTEGER,
    "date_mise_en_service" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bornes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affectations_borne" (
    "id" SERIAL NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "debut" TIMESTAMPTZ(3) NOT NULL,
    "fin" TIMESTAMPTZ(3),
    "emplacement_notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affectations_borne_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_lots" (
    "id" BIGSERIAL NOT NULL,
    "source" "ImportSource" NOT NULL,
    "type" "ImportType" NOT NULL,
    "borne_id" INTEGER,
    "borne_identifiant" TEXT,
    "schema_version" TEXT,
    "payload_sha256" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "recu_le" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_source" TEXT,
    "statut" "ImportStatut" NOT NULL,
    "nb_recues" INTEGER NOT NULL DEFAULT 0,
    "nb_creees" INTEGER NOT NULL DEFAULT 0,
    "nb_doublons" INTEGER NOT NULL DEFAULT 0,
    "nb_rejetees" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "import_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_erreurs" (
    "id" BIGSERIAL NOT NULL,
    "import_id" BIGINT NOT NULL,
    "index" INTEGER,
    "transaction_id_module" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "statut" "ImportErreurStatut" NOT NULL DEFAULT 'NOUVELLE',
    "traite_le" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_erreurs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" BIGSERIAL NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "transaction_id_module" TEXT NOT NULL,
    "lieu_id" INTEGER,
    "affectation_id" INTEGER,
    "horodatage" TIMESTAMPTZ(3) NOT NULL,
    "offset_minutes" INTEGER NOT NULL,
    "jour_local" DATE NOT NULL,
    "montant_ttc_cents" INTEGER NOT NULL,
    "taux_tva_bp" INTEGER NOT NULL,
    "montant_ht_cents" INTEGER NOT NULL,
    "devise" CHAR(3) NOT NULL DEFAULT 'EUR',
    "statut" "TransactionStatut" NOT NULL,
    "type_module_id" INTEGER NOT NULL,
    "module_id" INTEGER,
    "moyen_paiement" "MoyenPaiement" NOT NULL,
    "reference_monetique" TEXT,
    "produit_code" TEXT NOT NULL,
    "produit_libelle" TEXT,
    "nb_tirages" INTEGER NOT NULL,
    "transaction_origine_id" BIGINT,
    "logiciel_version" TEXT NOT NULL,
    "import_id" BIGINT NOT NULL,
    "recu_le" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rapprochement" "RapprochementStatut" NOT NULL DEFAULT 'NON_RAPPROCHE',

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "heartbeats" (
    "id" BIGSERIAL NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "horodatage" TIMESTAMPTZ(3) NOT NULL,
    "recu_le" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "papier_restant" INTEGER,
    "ruban_restant" INTEGER,
    "imprimante_ok" BOOLEAN,
    "module_paiement_ok" BOOLEAN,
    "erreurs" JSONB,
    "logiciel_version" TEXT,

    CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "releves_monetiques" (
    "id" SERIAL NOT NULL,
    "fournisseur" TEXT NOT NULL,
    "fichier_nom" TEXT NOT NULL,
    "periode_debut" DATE NOT NULL,
    "periode_fin" DATE NOT NULL,
    "importe_le" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "releves_monetiques_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "releve_lignes" (
    "id" BIGSERIAL NOT NULL,
    "releve_id" INTEGER NOT NULL,
    "identifiant_prestataire" TEXT NOT NULL,
    "reference_monetique" TEXT,
    "horodatage" TIMESTAMPTZ(3) NOT NULL,
    "montant_cents" INTEGER NOT NULL,
    "transaction_id" BIGINT,
    "statut" "RapprochementStatut" NOT NULL DEFAULT 'NON_RAPPROCHE',

    CONSTRAINT "releve_lignes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agg_jour" (
    "jour" DATE NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "type_module_id" INTEGER NOT NULL,
    "moyen_paiement" "MoyenPaiement" NOT NULL,
    "nb_acceptees" INTEGER NOT NULL DEFAULT 0,
    "nb_refusees" INTEGER NOT NULL DEFAULT 0,
    "nb_annulees" INTEGER NOT NULL DEFAULT 0,
    "nb_remboursees" INTEGER NOT NULL DEFAULT 0,
    "ca_ttc_cents" INTEGER NOT NULL DEFAULT 0,
    "ca_ht_cents" INTEGER NOT NULL DEFAULT 0,
    "rembourse_ttc_cents" INTEGER NOT NULL DEFAULT 0,
    "rembourse_ht_cents" INTEGER NOT NULL DEFAULT 0,
    "nb_tirages" INTEGER NOT NULL DEFAULT 0,
    "maj_le" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agg_jour_pkey" PRIMARY KEY ("jour","lieu_id","borne_id","type_module_id","moyen_paiement")
);

-- CreateTable
CREATE TABLE "agg_heure" (
    "jour" DATE NOT NULL,
    "heure" INTEGER NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "nb_acceptees" INTEGER NOT NULL DEFAULT 0,
    "ca_ttc_cents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "agg_heure_pkey" PRIMARY KEY ("jour","heure","lieu_id","borne_id")
);

-- CreateTable
CREATE TABLE "agg_disponibilite" (
    "jour" DATE NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "minutes_ouverture" INTEGER NOT NULL DEFAULT 0,
    "minutes_en_ligne" INTEGER NOT NULL DEFAULT 0,
    "nb_erreurs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "agg_disponibilite_pkey" PRIMARY KEY ("jour","borne_id")
);

-- CreateTable
CREATE TABLE "contrats_commission" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "date_effet" DATE NOT NULL,
    "date_fin" DATE,
    "modele" "ModeleCommission" NOT NULL,
    "base" "BaseCalcul" NOT NULL DEFAULT 'TTC',
    "net_remboursements" BOOLEAN NOT NULL DEFAULT true,
    "periodicite" "Periodicite" NOT NULL DEFAULT 'MOIS',
    "taux_bp" INTEGER,
    "seuil_cents" INTEGER,
    "seuil_mode" "SeuilMode",
    "seuil_cumul" "SeuilCumul",
    "forfait_cents" INTEGER,
    "minimum_garanti_cents" INTEGER,
    "paliers_mode" "PaliersMode",
    "motif_avenant" TEXT,
    "cree_par_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contrats_commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contrat_paliers" (
    "id" SERIAL NOT NULL,
    "contrat_id" INTEGER NOT NULL,
    "depuis_cents" INTEGER NOT NULL,
    "taux_bp" INTEGER NOT NULL,

    CONSTRAINT "contrat_paliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reversements" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "contrat_id" INTEGER NOT NULL,
    "periode_debut" DATE NOT NULL,
    "periode_fin" DATE NOT NULL,
    "statut" "ReversementStatut" NOT NULL DEFAULT 'A_CALCULER',
    "ca_ttc_cents" INTEGER NOT NULL DEFAULT 0,
    "ca_ht_cents" INTEGER NOT NULL DEFAULT 0,
    "rembourse_cents" INTEGER NOT NULL DEFAULT 0,
    "base_calcul_cents" INTEGER NOT NULL DEFAULT 0,
    "commission_calculee_cents" INTEGER NOT NULL DEFAULT 0,
    "ajustements_cents" INTEGER NOT NULL DEFAULT 0,
    "montant_a_reverser_cents" INTEGER NOT NULL DEFAULT 0,
    "detail_calcul" JSONB,
    "calcule_le" TIMESTAMPTZ(3),
    "valide_le" TIMESTAMPTZ(3),
    "numero_facture" TEXT,
    "facture_le" TIMESTAMPTZ(3),
    "paye_le" TIMESTAMPTZ(3),
    "pdf_chemin" TEXT,
    "envoye_le" TIMESTAMPTZ(3),
    "exporte_compta_le" TIMESTAMPTZ(3),

    CONSTRAINT "reversements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reversement_ajustements" (
    "id" SERIAL NOT NULL,
    "reversement_id" INTEGER NOT NULL,
    "montant_cents" INTEGER NOT NULL,
    "motif" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reversement_ajustements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regles_alerte" (
    "id" SERIAL NOT NULL,
    "type" "TypeAlerte" NOT NULL,
    "lieu_id" INTEGER,
    "niveau" "NiveauAlerte" NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "parametres" JSONB NOT NULL,

    CONSTRAINT "regles_alerte_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alertes" (
    "id" SERIAL NOT NULL,
    "type" "TypeAlerte" NOT NULL,
    "niveau" "NiveauAlerte" NOT NULL,
    "statut" "AlerteStatut" NOT NULL DEFAULT 'NOUVELLE',
    "lieu_id" INTEGER,
    "borne_id" INTEGER,
    "detectee_le" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cle_dedup" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "valeurs" JSONB,
    "commentaire" TEXT,
    "assignee_id" INTEGER,
    "resolue_le" TIMESTAMPTZ(3),

    CONSTRAINT "alertes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications_alerte" (
    "id" SERIAL NOT NULL,
    "alerte_id" INTEGER,
    "canal" "CanalNotif" NOT NULL,
    "destinataire" TEXT NOT NULL,
    "envoye_le" TIMESTAMPTZ(3),
    "erreur" TEXT,

    CONSTRAINT "notifications_alerte_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "couts_borne" (
    "id" SERIAL NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "categorie" "CategorieCout" NOT NULL,
    "montant_cents" INTEGER NOT NULL,
    "libelle" TEXT,
    "intervention_id" INTEGER,

    CONSTRAINT "couts_borne_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventions" (
    "id" SERIAL NOT NULL,
    "borne_id" INTEGER NOT NULL,
    "technicien_id" INTEGER,
    "date" TIMESTAMPTZ(3) NOT NULL,
    "motif" TEXT NOT NULL,
    "compte_rendu" TEXT,
    "en_panne_depuis" TIMESTAMPTZ(3),
    "resolue_le" TIMESTAMPTZ(3),

    CONSTRAINT "interventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evenements_lieu" (
    "id" SERIAL NOT NULL,
    "lieu_id" INTEGER NOT NULL,
    "type_id" INTEGER NOT NULL,
    "debut" TIMESTAMPTZ(3) NOT NULL,
    "fin" TIMESTAMPTZ(3),
    "libelle" TEXT NOT NULL,

    CONSTRAINT "evenements_lieu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "user_id" INTEGER,
    "entite" TEXT NOT NULL,
    "entite_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "avant" JSONB,
    "apres" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_keycloak_sub_key" ON "users"("keycloak_sub");

-- CreateIndex
CREATE UNIQUE INDEX "users_crm_id_key" ON "users"("crm_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ref_valeurs_categorie_code_key" ON "ref_valeurs"("categorie", "code");

-- CreateIndex
CREATE UNIQUE INDEX "lieux_crm_client_id_key" ON "lieux"("crm_client_id");

-- CreateIndex
CREATE INDEX "lieux_type_lieu_id_idx" ON "lieux"("type_lieu_id");

-- CreateIndex
CREATE INDEX "lieux_commercial_id_idx" ON "lieux"("commercial_id");

-- CreateIndex
CREATE INDEX "lieu_horaires_lieu_id_jour_semaine_idx" ON "lieu_horaires"("lieu_id", "jour_semaine");

-- CreateIndex
CREATE INDEX "lieu_saisons_lieu_id_debut_idx" ON "lieu_saisons"("lieu_id", "debut");

-- CreateIndex
CREATE INDEX "lieu_fermetures_lieu_id_debut_idx" ON "lieu_fermetures"("lieu_id", "debut");

-- CreateIndex
CREATE UNIQUE INDEX "gammes_code_key" ON "gammes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "types_module_paiement_code_key" ON "types_module_paiement"("code");

-- CreateIndex
CREATE UNIQUE INDEX "modules_paiement_type_id_numero_serie_key" ON "modules_paiement"("type_id", "numero_serie");

-- CreateIndex
CREATE UNIQUE INDEX "bornes_identifiant_key" ON "bornes"("identifiant");

-- CreateIndex
CREATE UNIQUE INDEX "bornes_numero_serie_key" ON "bornes"("numero_serie");

-- CreateIndex
CREATE UNIQUE INDEX "bornes_crm_id_key" ON "bornes"("crm_id");

-- CreateIndex
CREATE UNIQUE INDEX "bornes_api_key_prefix_key" ON "bornes"("api_key_prefix");

-- CreateIndex
CREATE INDEX "affectations_borne_borne_id_debut_idx" ON "affectations_borne"("borne_id", "debut");

-- CreateIndex
CREATE INDEX "affectations_borne_lieu_id_idx" ON "affectations_borne"("lieu_id");

-- CreateIndex
CREATE INDEX "import_lots_borne_id_recu_le_idx" ON "import_lots"("borne_id", "recu_le");

-- CreateIndex
CREATE INDEX "import_lots_payload_sha256_idx" ON "import_lots"("payload_sha256");

-- CreateIndex
CREATE INDEX "import_erreurs_statut_created_at_idx" ON "import_erreurs"("statut", "created_at");

-- CreateIndex
CREATE INDEX "transactions_lieu_id_horodatage_idx" ON "transactions"("lieu_id", "horodatage");

-- CreateIndex
CREATE INDEX "transactions_borne_id_horodatage_idx" ON "transactions"("borne_id", "horodatage");

-- CreateIndex
CREATE INDEX "transactions_jour_local_idx" ON "transactions"("jour_local");

-- CreateIndex
CREATE INDEX "transactions_lieu_id_idx" ON "transactions"("lieu_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_borne_id_transaction_id_module_key" ON "transactions"("borne_id", "transaction_id_module");

-- CreateIndex
CREATE UNIQUE INDEX "heartbeats_borne_id_horodatage_key" ON "heartbeats"("borne_id", "horodatage");

-- CreateIndex
CREATE INDEX "releve_lignes_identifiant_prestataire_horodatage_idx" ON "releve_lignes"("identifiant_prestataire", "horodatage");

-- CreateIndex
CREATE INDEX "agg_jour_lieu_id_jour_idx" ON "agg_jour"("lieu_id", "jour");

-- CreateIndex
CREATE INDEX "agg_heure_lieu_id_jour_idx" ON "agg_heure"("lieu_id", "jour");

-- CreateIndex
CREATE UNIQUE INDEX "contrats_commission_lieu_id_version_key" ON "contrats_commission"("lieu_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "contrats_commission_lieu_id_date_effet_key" ON "contrats_commission"("lieu_id", "date_effet");

-- CreateIndex
CREATE UNIQUE INDEX "contrat_paliers_contrat_id_depuis_cents_key" ON "contrat_paliers"("contrat_id", "depuis_cents");

-- CreateIndex
CREATE UNIQUE INDEX "reversements_lieu_id_periode_debut_key" ON "reversements"("lieu_id", "periode_debut");

-- CreateIndex
CREATE UNIQUE INDEX "regles_alerte_type_lieu_id_key" ON "regles_alerte"("type", "lieu_id");

-- CreateIndex
CREATE UNIQUE INDEX "alertes_cle_dedup_key" ON "alertes"("cle_dedup");

-- CreateIndex
CREATE INDEX "alertes_statut_niveau_idx" ON "alertes"("statut", "niveau");

-- CreateIndex
CREATE INDEX "couts_borne_borne_id_date_idx" ON "couts_borne"("borne_id", "date");

-- CreateIndex
CREATE INDEX "evenements_lieu_lieu_id_debut_idx" ON "evenements_lieu"("lieu_id", "debut");

-- CreateIndex
CREATE INDEX "audit_logs_entite_entite_id_idx" ON "audit_logs"("entite", "entite_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ref_valeurs" ADD CONSTRAINT "ref_valeurs_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_type_lieu_id_fkey" FOREIGN KEY ("type_lieu_id") REFERENCES "ref_valeurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_sous_type_id_fkey" FOREIGN KEY ("sous_type_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_standing_id_fkey" FOREIGN KEY ("standing_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_zone_geo_id_fkey" FOREIGN KEY ("zone_geo_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_taille_commune_id_fkey" FOREIGN KEY ("taille_commune_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_emplacement_zone_id_fkey" FOREIGN KEY ("emplacement_zone_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_eclairage_id_fkey" FOREIGN KEY ("eclairage_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_origine_lead_id_fkey" FOREIGN KEY ("origine_lead_id") REFERENCES "ref_valeurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieux" ADD CONSTRAINT "lieux_commercial_id_fkey" FOREIGN KEY ("commercial_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieu_contacts" ADD CONSTRAINT "lieu_contacts_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieu_clienteles" ADD CONSTRAINT "lieu_clienteles_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieu_clienteles" ADD CONSTRAINT "lieu_clienteles_ref_valeur_id_fkey" FOREIGN KEY ("ref_valeur_id") REFERENCES "ref_valeurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieu_horaires" ADD CONSTRAINT "lieu_horaires_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieu_horaires" ADD CONSTRAINT "lieu_horaires_saison_id_fkey" FOREIGN KEY ("saison_id") REFERENCES "lieu_saisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieu_saisons" ADD CONSTRAINT "lieu_saisons_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lieu_fermetures" ADD CONSTRAINT "lieu_fermetures_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modules_paiement" ADD CONSTRAINT "modules_paiement_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "types_module_paiement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modules_paiement" ADD CONSTRAINT "modules_paiement_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bornes" ADD CONSTRAINT "bornes_gamme_id_fkey" FOREIGN KEY ("gamme_id") REFERENCES "gammes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affectations_borne" ADD CONSTRAINT "affectations_borne_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affectations_borne" ADD CONSTRAINT "affectations_borne_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_lots" ADD CONSTRAINT "import_lots_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_erreurs" ADD CONSTRAINT "import_erreurs_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "import_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_affectation_id_fkey" FOREIGN KEY ("affectation_id") REFERENCES "affectations_borne"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_type_module_id_fkey" FOREIGN KEY ("type_module_id") REFERENCES "types_module_paiement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules_paiement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "import_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transaction_origine_id_fkey" FOREIGN KEY ("transaction_origine_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releve_lignes" ADD CONSTRAINT "releve_lignes_releve_id_fkey" FOREIGN KEY ("releve_id") REFERENCES "releves_monetiques"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releve_lignes" ADD CONSTRAINT "releve_lignes_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agg_jour" ADD CONSTRAINT "agg_jour_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agg_jour" ADD CONSTRAINT "agg_jour_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agg_jour" ADD CONSTRAINT "agg_jour_type_module_id_fkey" FOREIGN KEY ("type_module_id") REFERENCES "types_module_paiement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agg_heure" ADD CONSTRAINT "agg_heure_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agg_heure" ADD CONSTRAINT "agg_heure_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agg_disponibilite" ADD CONSTRAINT "agg_disponibilite_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contrats_commission" ADD CONSTRAINT "contrats_commission_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contrats_commission" ADD CONSTRAINT "contrats_commission_cree_par_id_fkey" FOREIGN KEY ("cree_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contrat_paliers" ADD CONSTRAINT "contrat_paliers_contrat_id_fkey" FOREIGN KEY ("contrat_id") REFERENCES "contrats_commission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reversements" ADD CONSTRAINT "reversements_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reversements" ADD CONSTRAINT "reversements_contrat_id_fkey" FOREIGN KEY ("contrat_id") REFERENCES "contrats_commission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reversement_ajustements" ADD CONSTRAINT "reversement_ajustements_reversement_id_fkey" FOREIGN KEY ("reversement_id") REFERENCES "reversements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reversement_ajustements" ADD CONSTRAINT "reversement_ajustements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alertes" ADD CONSTRAINT "alertes_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alertes" ADD CONSTRAINT "alertes_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alertes" ADD CONSTRAINT "alertes_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications_alerte" ADD CONSTRAINT "notifications_alerte_alerte_id_fkey" FOREIGN KEY ("alerte_id") REFERENCES "alertes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "couts_borne" ADD CONSTRAINT "couts_borne_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "couts_borne" ADD CONSTRAINT "couts_borne_intervention_id_fkey" FOREIGN KEY ("intervention_id") REFERENCES "interventions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_borne_id_fkey" FOREIGN KEY ("borne_id") REFERENCES "bornes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_technicien_id_fkey" FOREIGN KEY ("technicien_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenements_lieu" ADD CONSTRAINT "evenements_lieu_lieu_id_fkey" FOREIGN KEY ("lieu_id") REFERENCES "lieux"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evenements_lieu" ADD CONSTRAINT "evenements_lieu_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "ref_valeurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Contraintes hors Prisma (copie de prisma/sql/contraintes.sql) ───
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
