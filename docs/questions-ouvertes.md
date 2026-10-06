# Points à valider avant développement

Chaque point indique **le choix retenu par défaut dans les schémas**. Il suffit de confirmer ou de corriger.

## Commissions

> Implémenté : les points 1 à 3 sont réglables par contrat ; le point 4 suit la règle par défaut (date d'effet au début d'une période). À confirmer quand même avec Sébastien pour les contrats existants.

1. **« Pourcentage après seuil » : au-delà, ou dès qu'il est atteint ?** (le CDC note « à préciser »)
   → Les deux sont gérés, au choix pour chaque contrat (`seuil_mode` = `AU_DELA` | `DES_ATTEINTE`).
   Exemple pour 25 % au-delà de 500 € avec un CA de 800 € : `AU_DELA` donne 75 €, `DES_ATTEINTE` donne 200 €.
2. **Paliers : chaque tranche à son propre taux, ou un taux unique sur tout le CA ?**
   Exemple pour 10 % jusqu'à 1 000 € puis 20 % au-delà, avec un CA de 1 500 € : `MARGINAL` donne 200 €, `GLOBAL` donne 300 €.
   → Les deux sont gérés (`paliers_mode`).
3. **Minimum garanti** : se combine-t-il avec les autres modèles (par exemple max(20 % du CA ; 100 €)) ?
   → Oui. C'est un champ à part, combinable avec tous les modèles.
4. **Avenant en cours de période** (par exemple le 15 du mois) : on applique un prorata, ou le nouveau contrat ne démarre qu'à la période suivante ?
   → Par défaut, la date d'effet est forcée au début d'une période.
5. **Base HT** : quel taux de TVA appliquer sur les ventes photo ? → 20 % par défaut, configurable. Si besoin, la borne peut envoyer `taux_tva_pct`. À valider avec l'expert-comptable.

## Ingestion

6. **Changement de statut d'une transaction déjà reçue** (par exemple acceptée puis remboursée) : on attend un nouvel événement (avec son propre `transaction_id` et `transaction_origine_id`), pas une modification de l'événement d'origine.
   → Si une borne renvoie le même `transaction_id` avec un contenu différent, il part dans la file d'erreurs (`CONFLIT_DOUBLON`). Il n'est jamais écrasé.
7. **Les transactions refusées sont-elles bien envoyées par les bornes ?** Il en faut pour calculer le taux de refus et déclencher son alerte.
8. **Fréquence du heartbeat** : 5 minutes par défaut. Seuil de l'alerte « borne muette » : 3 h par défaut, uniquement pendant les heures d'ouverture.
9. **Dépôt de fichiers en plus de l'API** : les bornes actuelles savent-elles faire un POST HTTPS ? Si oui, l'API seule suffit en V1.
10. **Relevés Ingenico** : sous quel format (CSV, portail, API) ? On a besoin d'un exemple de fichier pour le rapprochement.

## Fiche lieu et accès

11. **Lieux et bornes dans le CRM** : ils existent déjà dans le CRM Selfizee. Faut-il les synchroniser comme dans `ventes-bornes` (RabbitMQ, `crm_id`), ou les saisir dans cette application ?
12. **Commercial** : voit-il seulement ses propres lieux, ou tous les lieux sans les réglages de commission ?
    → Par défaut, seulement ses propres lieux (CDC §9.2).
13. **Front-end** : le CDC demande Next.js, alors que `ventes-bornes` utilise React + Vite.
    → On garde Next.js, comme demandé dans le CDC.

## Constats faits avec les données de démo

14. **Journée d'exploitation des lieux de nuit.** Aujourd'hui, une vente faite à 1 h du matin dans la nuit du vendredi au samedi est comptée le **samedi**, comme dans un calendrier. Pour une boîte de nuit, on raisonne plutôt en « soirée du vendredi ».
    → Proposition : une heure de bascule réglable dans la fiche lieu (par exemple 6 h), utilisée pour le jour des statistiques et pour les commissions.
15. **Ventes datées dans le futur** (horloge de la borne décalée) : elles sont aujourd'hui acceptées telles quelles.
    → **Fait** : au-delà de 1 h dans le futur, la vente part dans la file d'erreurs (`HORODATAGE_FUTUR`).
16. **Débit d'ingestion** : **fait**, traitement par lot (une transaction SQL par lot) : un rattrapage de 500 ventes prend environ 1,2 s en local, contre environ 20 s auparavant.

## Rapprochement monétique

17. **Format du relevé Ingenico** : nous n'avons pas d'exemple de fichier. L'import accepte donc n'importe quel CSV : on indique quelle colonne contient la date, l'heure, le montant, le n° de terminal et le n° d'autorisation, et ce choix est retenu pour le prochain import du même prestataire.
    → À confirmer avec un vrai relevé : le n° de terminal (TID) y figure-t-il, et le n° d'autorisation remonté par la borne (`reference_monetique`) est-il le même que celui du relevé ?
18. **TID des bornes** : il faut le saisir sur la fiche de chaque borne (section « Module de paiement »). Sans lui, les lignes du relevé apparaissent en « terminal inconnu ».
19. **Tolérances de rapprochement** : même montant à 10 minutes près ; montant différent à 2 minutes près = écart de montant ; même n° d'autorisation à 24 h près. Ces valeurs sont à ajuster après un premier relevé réel.
