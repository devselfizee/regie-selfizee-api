-- Galerie : séances payées retrouvées par le photo_uuid des ventes (filtre « payées », montant de chaque séance)
-- CreateIndex
CREATE INDEX "transactions_pikcloud_uuid_idx" ON "transactions"("pikcloud_uuid");
