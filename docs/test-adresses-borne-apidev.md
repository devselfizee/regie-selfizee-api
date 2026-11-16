# Test en dev : « Recevoir par e-mail » depuis la borne, via apidev

Recette de bout en bout borne → apidev.pikcloud.io → API Régie de dev → mail. Fonction livrée le 16/11/2026 (`docs/avenant-synchro-adresses-borne.md`).

## 1. Avant de commencer

| Côté | À vérifier |
|---|---|
| PikCloud apidev | la branche `feature/platform-kalifun-regie` du 16/11 est déployée (rappel du webhook sur fiche modifiée, statut 1017) ; `REGIE_SYNCHRO_URL` et `REGIE_SYNCHRO_SECRET` pointent sur l'API Régie de dev |
| API Régie (Coolify) | déployée depuis `main` ≥ `f1c8f4d` ; variables `PIKCLOUD_SYNCHRO_SECRET` (même valeur que chez PikCloud), `MAILJET_API_KEY` et `MAILJET_API_SECRET` (sans elles, rien ne part, l'envoi est seulement journalisé), `SOUVENIR_QR_BASE_URL` sur le domaine de la page souvenir |
| Front Régie | déployé depuis `main` ≥ `57dedd5` |
| Borne | `TEST01` (lieu « test », événement `RDBT`), logiciel 2.0 avec l'option « Recevoir par e-mail » |

Contrôle rapide que le webhook est joignable : un `POST` sans en-tête sur `https://<api-dev>/webhooks/v1/pikcloud/medias` doit répondre `401`.

## 2. Le test

1. **Séance sur la borne**, puis achat numérique seul (imprimante bloquée) et « Recevoir par e-mail » avec une première adresse, par exemple la vôtre.
2. **Dans la minute**, dans la Régie : fiche du lieu « test » › Configuration › menu de l'événement par défaut › **Galerie**, cliquer la photo. La fiche doit montrer :
   - Vente : le paiement de 1,50 € ;
   - **E-mails : « 1 envoyé sur 1 adresse », puis en dessous « 1 tapée sur la borne »**. Tant que le mail n'est pas parti : « 1 en attente ».
3. **Le mail arrive** : sujet « Tes photos de test sont là », photo en pièce jointe, lien « ta page » qui ouvre la page souvenir de cette séance, identique au QR de la borne.
4. **Deuxième adresse** depuis la même séance sur la borne (bouton « Recevoir par e-mail » de nouveau). La fiche passe à « 2 envoyés sur 2 adresses · 2 tapées sur la borne ». **La première adresse ne reçoit rien de plus.**
5. **Même adresse une seconde fois** : rien ne change, aucun mail en double.

## 3. Où regarder si ça ne marche pas

| Symptôme | Où voir | Cause probable |
|---|---|---|
| Pas de ligne E-mails sur la fiche | Journal des bornes › Envois, type « Médias PikCloud » : y a-t-il un appel avec `data_url` après la demande ? | PikCloud n'a pas rappelé le webhook (branche pas déployée), ou la fiche n'a pas de `shareWithOthers` |
| Ligne « JSON de la séance annoncé, téléchargement en cours » qui reste | Journal des bornes › Erreurs | lien `data_url` qui ne répond pas ; bouton « Relancer le téléchargement » (admin) sur la fiche |
| « 1 en attente » qui ne part jamais | variables Mailjet de l'API de dev ; journal de l'API (« Page souvenir : … mail(s) envoyé(s) ») | identifiants Mailjet absents ou refusés |
| Mail parti mais lien de page souvenir cassé | `SOUVENIR_QR_BASE_URL` de l'API de dev | base du lien absente ou pointant sur la prod |
| Adresse ignorée | la séance est de test (`is_fake`, `testMode`), ou son événement est inconnu de la Régie | normal : rien ne part pour le public dans ces cas |

En base, pour un admin : `souvenir_inscriptions` (une ligne par adresse et par photo, `origine = BORNE`) et `souvenir_livraisons` (état de chaque envoi : `A_ENVOYER`, `ENVOYE`, `ECHEC`, `EN_ATTENTE_MEDIA`).
