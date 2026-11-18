# Réponse à l'avenant « événement booth programmé dans la Régie »

Demande du 18/11/2026 (équipe borne, `REGIE-AVENANT-PROGRAMME-BOOTH.md`) : pouvoir programmer, sur un lieu de la Régie, un
événement créé dans booth, pour que la borne bascule dessus à l'heure dite sans qu'on touche à la borne. Ce document dit
ce que la Régie a fait, répond aux deux questions de l'avenant, et pose la nôtre.

Référence : *Mise à jour automatique des événements sur les bornes*, passée en **v1.2** du 18/11/2026
(`docs/mise-a-jour-evenements-bornes.md`, section « Événement booth dans le programme »).

## 1. Réponses aux questions de l'avenant

| Question | Réponse |
|---|---|
| Le nom du champ `origine` et ses valeurs conviennent-ils ? | **Oui.** `origine` est présent sur **tous** les événements du programme et de `versions` : `"regie"` pour un événement de la Régie, `"booth"` pour un code booth. La borne n'a pas à déduire l'origine du préfixe `R` du code. |
| `version: 0` dans `installation` : accepté ? | **Oui**, dès maintenant (le schéma accepte `version` à partir de 0). Pour un booth, envoyer `version: 0`, celle reçue dans le programme. |

## 2. Ce que la Régie fait

- **Programmation** : fiche du lieu › Configuration › « + Nouvel événement » › choix « Événement booth ». L'exploitant
  saisit le code booth (3 à 8 lettres ou chiffres, mis en majuscules), un nom facultatif pour s'y retrouver, et le
  créneau (début et fin, avec heures). **Aucune vérification du code auprès de booth**, comme demandé : seule la forme
  est contrôlée. Le même code peut être programmé sur plusieurs lieux.
- **Programme de la borne** : le créneau arrive dans `actuel` ou `prochains` avec `origine: "booth"`, `version: 0`,
  `publieLe: null`, `status: "complete"`, `debut`/`fin` ou `jusqua` comme un événement Régie. Même règle de priorité
  entre créneaux qui se chevauchent : celui qui a commencé le plus tard tourne. À la fin du créneau, la borne revient à
  l'événement suivant du programme, en général le par défaut de la Régie.
- **`statut` et `versions`** répondent `unknown` pour un code booth : rien à télécharger chez la Régie.
- **`installation`** : `INSTALLE` ou `ECHEC` avec `version: 0` sont enregistrés comme pour un événement Régie, et
  affichés dans la Régie à côté du créneau (c'est ainsi que l'exploitant verra un code qui n'existe pas dans booth :
  merci de renvoyer le message de booth, par exemple `BadEventCode`, dans `message`).
- Pas de galerie, de page souvenir ni de ventes Régie pour un créneau booth : tout reste dans booth.

Exemple de programme avec un booth à venir :

```json
{
  "actuel": { "code": "RDEF", "origine": "regie", "nom": null, "parDefaut": true, "version": 3, "publieLe": "…", "status": "complete",
              "jusqua": "2026-11-22T19:00:00.000+01:00" },
  "prochains": [
    { "code": "AB12", "origine": "booth", "nom": "Soirée privée", "parDefaut": false, "version": 0, "publieLe": null,
      "status": "complete", "debut": "2026-11-22T19:00:00.000+01:00", "fin": "2026-11-23T02:00:00.000+01:00" }
  ]
}
```

## 3. Ce que nous attendons de la borne

1. Lire `origine` ; pour `"booth"`, charger le code **par booth** (comme un code tapé), sans appeler `statut` ni
   chercher de zip, à l'heure du créneau.
2. Signaler `INSTALLE` (`version: 0`) quand il tourne, `ECHEC` avec le message de booth sinon, avec
   `declencheur: "auto"`.
3. Revenir au programme de la Régie à `jusqua`.

## 4. Notre question : le booth « par défaut »

L'avenant dit « par défaut, ou sur un créneau daté ». Nous avons livré le **créneau daté**. Un booth comme événement par
défaut d'un lieu remplacerait l'événement permanent de la Régie, donc ses ventes, sa galerie et sa page souvenir. Est-ce
un besoin réel ? Si oui, dites-le nous : c'est un réglage de plus sur le lieu, et le programme renverrait alors un
`actuel` booth avec `parDefaut: true`.

## 5. Récapitulatif

| Sujet | Qui | État |
|---|---|---|
| Programmation d'un code booth sur un créneau, `origine` dans le programme, `version: 0` acceptée | Régie | **livré** (API et front, contrat v1.2) |
| Chargement par booth d'un créneau `origine: "booth"`, signalement `INSTALLE`/`ECHEC` en version 0 | borne | à faire |
| Booth comme événement par défaut du lieu | exploitant / borne | à confirmer (§ 4) |
