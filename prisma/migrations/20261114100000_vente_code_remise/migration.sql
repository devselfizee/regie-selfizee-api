-- Code de remise utilisé pour une vente (retour de Sébastien du 13/11 : relier une vente à son code)
ALTER TABLE "transactions" ADD COLUMN "code_remise" VARCHAR(20);
CREATE INDEX "transactions_code_remise_idx" ON "transactions"("code_remise");
