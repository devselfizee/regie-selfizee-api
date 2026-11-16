# Avenant à la synchro PikCloud → Régie : adresses e-mail saisies sur la borne

Demande du 16/11/2026 (équipe borne) : quand un invité choisit « Recevoir par e-mail » sur une borne d'un événement Régie, la borne ajoute son adresse dans la fiche JSON de la photo (`shareWithOthers`) et renvoie cette fiche par la synchro habituelle. C'est le serveur Régie qui envoie le message. Ce document dit ce que Régie va faire, et ce dont elle a besoin de PikCloud pour que ça marche dans tous les cas.

Référence : *Synchronisation des médias PikCloud → plateforme Régie*, version 1 du 04/11/2026 (le « contrat »).

## 1. Ce que Régie fait

- Régie lit `shareWithOthers` dans le JSON de la séance : une chaîne contenant un tableau JSON d'adresses (`"[\"prenom@exemple.fr\"]"`), un tableau direct est accepté aussi.
- Pour chaque adresse **pas encore servie pour cette photo**, Régie envoie le mail de livraison de la page souvenir : la photo en pièce jointe et le lien de la page souvenir, **le même que le QR code imprimé et affiché sur la borne** (`<base>/p/<code_event>-<photo_uuid>`).
- Une adresse n'est servie qu'une fois par photo. La fiche peut revenir autant de fois que nécessaire avec la liste complète : seules les adresses nouvelles reçoivent un mail.
- Si la photo n'est pas encore téléchargée quand la fiche arrive, le mail part dès qu'elle l'est.
- `digital_only` est conservé sur la séance (achat numérique sans tirage).

Rien ne change pour PikCloud dans le format de l'appel ni dans la réponse du webhook (contrat § 3 et § 5).

## 2. Ce dont Régie a besoin de PikCloud

### 2.1 Renvoyer la fiche JSON quand la borne la renvoie modifiée

Le contrat (§ 3.2) dit qu'un renvoi transporte toujours le même fichier et que PikCloud ne remplace jamais un fichier déjà reçu d'une borne. Ce n'est plus vrai pour la fiche JSON : la borne la renvoie **modifiée** à chaque nouvelle demande d'e-mail, parfois plusieurs minutes après la première synchro (invité qui revient à la borne, deuxième adresse).

Il faut donc que, quand la borne renvoie la fiche JSON d'une séance déjà synchronisée (même `upload_uuid` d'après le CDC page souvenir § 2.1) :

1. PikCloud **remplace** le fichier JSON stocké par la nouvelle version ;
2. PikCloud **rappelle le webhook Régie** avec `data_url` (et `media_url` s'il l'accompagne, comme pour le cas B), avec `source` à `"upload"` ou `"force"`, indifféremment.

Côté Régie, toute annonce d'un `data_url`, première ou non, entraîne le retéléchargement et la relecture du JSON (quelques Ko). La réponse reste `success: true`, avec le message `"Fichier mis à jour"` quand le JSON était déjà connu. Pas de nouveau code d'erreur.

**Question à confirmer :** est-ce déjà le comportement de PikCloud quand la borne renvoie un JSON avec le même `upload_uuid` ? Si le webhook n'est pas rappelé, Régie ne saura jamais qu'une adresse a été ajoutée après la première synchro.

### 2.2 Le cas où la borne n'a pas encore synchronisé

Quand l'invité tape son adresse avant la première synchro de la séance, la fiche arrive déjà remplie au premier appel du webhook. Ce cas fonctionne sans changement côté PikCloud.

### 2.3 Une fiche JSON jamais annoncée

Sur l'environnement de dev, la séance `RDBT` / `TEST01` / `2026_11_13_10_48_25_00003` a sa fiche JSON chez PikCloud (visible à son URL), mais Régie n'a reçu qu'un appel avec `media_url`, jamais de `data_url` pour cette séance. Pouvez-vous regarder dans le back-office PikCloud (erreurs de transfert, plateforme Régie) pourquoi le `.json` n'est pas parti ? Sans la fiche, Régie n'a ni `photo_uuid`, ni adresses, ni lien de page souvenir pour cette photo.

## 3. Question pour l'équipe borne : le format de `photo_uuid`

Le contrat et le CDC décrivent `photo_uuid` comme un UUID (`3f9c2a7e-5b1d-4c8a-9e21-7d4b0c6a1f53`). La borne en version `2.0.3195` envoie une empreinte de 64 caractères hexadécimaux (`7ee1227180c5af6f62348b8f0a1119988cb6c33813d7dee7a82137854d5fe7ab`).

Régie va élargir ses colonnes pour accepter les deux formes, et reprendra la valeur telle quelle dans le lien de la page souvenir, comme le QR de la borne. Nous avons besoin de savoir si ce format en 64 caractères est **définitif** sur la version 2.0, pour ne pas migrer deux fois, et si les ventes envoyées par la borne (`pikcloud_uuid` du schéma des transactions) porteront la même valeur, puisque c'est la clé qui relie une vente à sa photo.

## 4. Récapitulatif

| Sujet | Qui | Quoi |
|---|---|---|
| Lecture de `shareWithOthers`, envoi du mail, pas de doublon | Régie | en cours |
| Rappel du webhook quand la fiche JSON est renvoyée modifiée | PikCloud | à confirmer ou à mettre en place (§ 2.1) |
| Fiche JSON de `RDBT` jamais annoncée en dev | PikCloud | à diagnostiquer (§ 2.3) |
| Format de `photo_uuid` en 64 caractères : définitif ? même valeur dans les ventes ? | équipe borne | à confirmer (§ 3) |
