# Réponse à l'avenant « événement booth sur mesure »

Demande du 24/11/2026 (exploitant, pour l'équipe web, `REGIE-AVENANT-BOOTH-SUR-MESURE.md`) : pouvoir dire dans la Régie
qu'un événement booth est **sur mesure**, déposer son zip dans la Régie, et que la Régie le serve aux bornes comme un de
ses événements. Ce document dit ce que la Régie a fait, répond aux trois questions de l'avenant, et pose les nôtres.

Référence : *Mise à jour automatique des événements sur les bornes*, passée en **v1.3** du 25/11/2026
(`docs/mise-a-jour-evenements-bornes.md`, section « Événement booth sur mesure »).

## 1. Réponses aux questions de l'avenant

| Question | Réponse |
|---|---|
| « `origine: "booth"` + version ≥ 1 = zip chez vous » : cette lecture vous convient-elle ? | **Oui.** Pas de champ en plus. `version: 0` garde son sens (la borne prend l'événement chez booth) ; 1 ou plus veut dire « zip à la Régie ». Le numéro ne redescend jamais : deux zips différents n'ont jamais le même numéro. |
| Taille maximale d'un zip déposé ? | **100 Mo.** Au-delà, le dépôt est refusé dans la Régie, avec un message. |
| Le contrôle du code du `config.json` au dépôt : faisable ? | **Oui, en place.** Le `config.json` doit porter dans `event.code` le code du créneau (comparé en majuscules). Sinon le dépôt est refusé et la personne voit pourquoi : « Le config.json de ce zip porte le code Y, pas X ». Sont refusés aussi : un fichier qui n'est pas un zip, un zip sans `config.json`, un `config.json` illisible ou sans code. |
| *(format du zip)* | La Régie sert **toujours le format de ses propres zips** : `config.json` et dossiers de l'événement à la racine. Un zip téléchargé de booth range tout dans un dossier au nom du code (`D229/config.json`) : il est accepté tel quel au dépôt et **remis à la racine** (fichiers macOS `__MACOSX` retirés). `taille` et `sha256` sont ceux du zip servi. Merci de nous confirmer que c'est bien ce format que la borne attend pour un booth en version ≥ 1. |

## 2. Ce que la Régie fait

- **Où** : fiche du lieu › Configuration › sur un créneau booth, menu ⋯ › « Événement sur mesure ». La fenêtre montre
  la version servie, le fichier déposé (nom, taille, date, auteur, empreinte), la case **« Événement sur mesure »**, le
  dépôt d'une nouvelle version, et les bornes du lieu avec la version de leur logiciel.
- **Un zip par code booth** : il vaut pour tous les créneaux de ce code, sur tous les lieux où il est programmé. La
  fenêtre prévient quand le code est aussi programmé ailleurs.
- **Chaque dépôt = une version de plus** (1, 2, 3…), avec sa taille et son empreinte SHA-256, et coche la case. La
  version précédente reste disponible un temps pour une borne en plein téléchargement.
- **Décocher la case** : le programme renvoie `version: 0`, la borne reprend la version de booth. **Recocher** : le
  dernier zip revient, avec son numéro (même contenu). Un nouveau dépôt prend toujours le numéro suivant.
- **Programme** : le créneau arrive avec `origine: "booth"`, `version` du dernier dépôt, `publieLe` (date du dépôt),
  `status: "complete"` quand le zip est prêt.
- **`statut`** répond comme pour un événement Régie : `status`, `version`, `taille`, `sha256`, `publieLe`, `url` signée
  15 minutes, reprise `Range`. Même règle d'accès : la borne doit être rattachée à un lieu où le code est programmé.
  L'URL est de la forme `…/ingest/v1/evenements/booth/<code>/zip?…` : à utiliser telle quelle.
- **`versions`** donne aussi la version de ces codes (un code booth sans zip reste `unknown`).
- **`installation`** : `TELECHARGE`, `INSTALLE`, `ECHEC` avec la vraie version, enregistrés comme pour un événement
  Régie. Dans la liste des événements, chaque borne du lieu affiche « à jour (v2) », la version en cours, ou un échec.
- **Borne pas à jour** : une borne qui signale la version 0 après le dépôt du zip (logiciel du 16/11 au 24/11) est
  affichée « a pris la version booth : logiciel à mettre à jour ».
- **Un code booth qui est aussi celui d'un événement Régie** : dépôt refusé (la borne chargerait l'événement Régie).
- Le zip retiré ou remplacé n'est jamais supprimé des bornes par la Régie : comme vous l'indiquez, la borne garde ses
  événements booth sur son disque.

## 3. Ce que nous attendons de la borne

1. Pour une entrée `origine: "booth"` avec `version` ≥ 1 : passer par `statut` puis le zip, vérifier l'empreinte et le
   code du `config.json`, reprendre après une coupure (c'est ce que décrit votre avenant).
2. Signaler `TELECHARGE` / `INSTALLE` / `ECHEC` avec la vraie version.
3. Revenir à booth quand la version repasse à 0.

## 4. Nos questions

1. **Quelle `logiciel_version`** (heartbeat) correspond au logiciel livré avec cet avenant ? Votre avenant demande de ne
   proposer la case qu'aux lieux dont les bornes sont à jour. Sans ce numéro, la Régie ne bloque rien : elle affiche la
   version du logiciel de chaque borne dans la fenêtre « Événement sur mesure », et signale une borne qui prend la
   version booth. Avec le numéro, nous pourrons avertir avant le dépôt.
2. **Le code lu dans le `config.json`** : nous lisons `event.code`, comme dans les `config.json` de booth et de la
   Régie. Est-ce bien le champ que la borne compare ?

## 5. Récapitulatif

| Sujet | Qui | État |
|---|---|---|
| Dépôt du zip (100 Mo, contrôle du code, zip de booth remis à la racine), versions, case « sur mesure » | Régie | **livré** (API et front) |
| Programme `origine: "booth"` + version ≥ 1, `statut`, zip signé, `versions`, `installation` avec la vraie version | Régie | **livré** (contrat v1.3) |
| Suivi par borne de la version installée, borne qui prend la version booth signalée | Régie | **livré** |
| Chargement du zip de la Régie pour un booth en version ≥ 1 | borne | en place d'après l'avenant |
| Numéro de `logiciel_version` des bornes à jour | borne | **à nous donner** (§ 4) |
