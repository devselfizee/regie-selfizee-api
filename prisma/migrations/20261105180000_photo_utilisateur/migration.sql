-- Photo du compte Konitys (plateforme), relevée à la connexion : avatars de la timeline
ALTER TABLE "users" ADD COLUMN "photo_url" TEXT;
ALTER TABLE "users" ADD COLUMN "photo_verifiee_le" TIMESTAMPTZ(3);
