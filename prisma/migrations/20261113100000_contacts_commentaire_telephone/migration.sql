-- Contacts du lieu (retour du 12/11) : commentaire libre sur chaque contact, et téléphones existants ramenés au format
-- international E.164 (« +33669045935 ») comme à l'enregistrement (src/lib/telephone.ts). Un numéro qu'on ne sait pas
-- lire reste tel quel : il sera à corriger au prochain enregistrement du lieu.
ALTER TABLE "lieu_contacts" ADD COLUMN "commentaire" TEXT;

-- « 0033 6 69… » → « +33669… »
UPDATE "lieu_contacts" SET "telephone" = '+' || substring(regexp_replace("telephone", '[^0-9]', '', 'g') from 3)
WHERE btrim("telephone") LIKE '00%' AND regexp_replace("telephone", '[^0-9]', '', 'g') ~ '^00[1-9][0-9]{6,14}$';

-- « +33 6 69 04… » → chiffres seuls derrière le « + »
UPDATE "lieu_contacts" SET "telephone" = '+' || regexp_replace("telephone", '[^0-9]', '', 'g')
WHERE btrim("telephone") LIKE '+%' AND regexp_replace("telephone", '[^0-9]', '', 'g') ~ '^[1-9][0-9]{6,14}$';

-- « +33 (0)6… », « +33 06… » : le 0 de trop après l'indicatif
UPDATE "lieu_contacts" SET "telephone" = '+33' || substring("telephone" from 5)
WHERE "telephone" ~ '^\+330[1-9][0-9]{8}$';

-- « 06 69 04 59 35 » (français sans indicatif) → « +33669045935 »
UPDATE "lieu_contacts" SET "telephone" = '+33' || substring(regexp_replace("telephone", '[^0-9]', '', 'g') from 2)
WHERE btrim("telephone") NOT LIKE '+%' AND regexp_replace("telephone", '[^0-9]', '', 'g') ~ '^0[1-9][0-9]{8}$';
