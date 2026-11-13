-- Page « Historique » : index de date sur les sources lues (journal d'audit, alertes, envois refusés des bornes)
-- CreateIndex
CREATE INDEX "import_lots_statut_recu_le_idx" ON "import_lots"("statut", "recu_le");
-- CreateIndex
CREATE INDEX "alertes_detectee_le_idx" ON "alertes"("detectee_le");
-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
