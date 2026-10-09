# Réponse à l'avenant « synchronisation des ventes » (07/10/2026)

À l'attention du développeur du logiciel des bornes (`piktoo-QT-2026`).

Le **schéma 1.1** est publié. Il reprend les huit demandes de l'avenant. Les schémas JSON du dépôt `regie-selfizee-api` (`schemas/transactions.v1.schema.json`, `schemas/heartbeat.v1.schema.json`) acceptent `schema_version` `"1.1"`, et toujours `"1.0"`. La spécification à jour est `docs/synchronisation-bornes.md`, et sa version illustrée `docs/synchronisation-bornes.html`.

| # | Demande | Réponse |
|---|---|---|
| 1 | Statuts `expire`, `offert`, champ `encaissement` | **Fait**, avec `motif`. `offert` ne fait pas de chiffre d'affaires et n'est pas reversé au lieu ; il compte en « tirage non facturé ». `expire` est hors taux de refus et compté à part. `incertain` est compté dans le CA et signalé dans le rapport de rapprochement. |
| 2 | `transaction_id` généré par la borne, n° d'autorisation dans `reference_monetique` | **Fait**. La description du schéma est corrigée. `reference_sequence` est ajouté (facultatif) : envoyez-le, il pourra départager deux paiements au même montant. |
| 3 | Paiement QR Stripe | **Fait** : module `STRIPE_QR`, moyen `web`. Ces ventes sont hors rapprochement avec les relevés du terminal. |
| 4 | Produits `NUMERIQUE`, `POSTAL`, `nb_tirages` à 0 | **Fait**. Les codes produit restent libres ; `TIRAGE`, `TIRAGE_EXTRA`, `NUMERIQUE` et `POSTAL` sont ceux affichés dans les statistiques. |
| 5 | Module Hexapay, n° de série par réglage | **Fait** : `HEXAPAY` dans le référentiel, `numero_serie` facultatif. Les gammes Spherik, Kalifun et Classic sont ajoutées. |
| 6 | Séances à 0 € | **Accepté par la plateforme** : moyen `aucun`, champ `gratuite`, `statut: "accepte"`, montant `0`. Elles ne comptent ni comme vente ni dans le CA, mais apparaissent dans l'activité et les tirages non facturés. Reste à Selfizee de confirmer que les bornes les envoient. |
| 7 | Clé par le JSON de settings, identifiants `S513` / `K001` / `C042` | **D'accord**. Ces identifiants respectent déjà le format. Les bornes seront créées avec eux. Un `401` après régénération de la clé ne fait rien perdre. |
| 8 | `ruban_restant` absent, codes d'erreur | **Fait** : `ruban_restant` facultatif. Votre référentiel de codes est publié tel quel. Un code inconnu est accepté et conservé : le heartbeat n'est jamais refusé pour un libellé. |
| § 3.7 | Remboursements | Saisis en back-office (page **Ventes** de la plateforme), rattachés à la vente d'origine, partiels possibles. La borne n'envoie jamais `rembourse`. |
| § 5 | Pikcloud | **Fait** : champ facultatif `pikcloud_uuid` (UUID). |
| § 5 | Journal Hexapay | Oui, merci pour l'extrait réel. Avec un relevé du prestataire, il servira à régler l'import du rapprochement. |
| § 5 | URL de DEV | Disponible : Selfizee vous la communique avec une clé de test. |

**Règles de cohérence** ajoutées au schéma. Une vente qui ne les respecte pas est rejetée seule (`SCHEMA_INVALIDE`), sans bloquer le reste du lot :
- `encaissement` seulement avec `accepte` ;
- `gratuite` seulement avec `aucun` ;
- `aucun` seulement à 0 € et avec `accepte` ;
- pas de `reference_monetique` avec `especes` ou `aucun`.

Vos scénarios de test sont couverts par les tests de la plateforme : accepté enregistré, accepté non enregistré, incertain, refusé, annulé, expiré, paiement supplémentaire, QR, séance gratuite.
