## 🔐 Droits Konitys — à appliquer à CHAQUE modification (obligatoire)

Cette app expose ses droits à l'Admin Panel Konitys (clé d'app : `regie`).
Référence complète : `docs/PERMISSIONS_APP_INTEGRATION.md`.

**Avant de terminer toute tâche qui modifie le code**, relis UNIQUEMENT ce que tu viens de changer et applique :

| Tu as ajouté… | Tu dois… |
|---|---|
| une route API qui écrit (POST/PUT/PATCH/DELETE) ou une lecture sensible | la protéger : `requirePerm('<entite>.<action>')` (Flask : `@require_perm(...)` sous `@app.route`), sauf si elle est déjà réservée aux admins au montage |
| un bouton / une action sensible (créer, modifier, supprimer, exporter, envoyer…) | React : l'entourer de `<Gate perm="...">` ou utiliser `usePerm` ; pages serveur : `data-perm="regie:<clé>"` |
| une page ou une route du frontend | ajouter `pages.<page>.view` au schéma + `<PageGuard perm="pages.<page>.view">` (pages serveur : `@require_perm` sur la route) |
| une clé qui n'existe pas encore | l'ajouter au schéma des droits (bon groupe, libellé français) et incrémenter `version` |

Règles :
- Clés sans préfixe d'app dans `requirePerm` / `Gate` / `usePerm` / `PageGuard` ; avec préfixe uniquement dans `data-perm`.
- Ne JAMAIS supprimer ni renommer une clé du schéma (droits orphelins en base). Fonction retirée → la clé reste ; signale-le.
- Jamais de contrôle codé en dur (`if (user.id === 141)`, test d'e-mail…). Les admins Keycloak passent déjà partout.
- Jamais de rôle propre à l'app, ni de rôle Keycloak autre que `admin` pour décider d'un accès : un droit du schéma à la place.
- Périmètre des données (« les siens » / « tous ») : toujours via `peutVoirTout()` (mode fermé), jamais via `userCan()` ni via un rôle.
- Si l'API et le front sont dans deux dépôts : le schéma vit dans l'API ; une nouvelle page ou un nouveau bouton du front y ajoute sa clé.
- Ne jamais afficher la clé d'un droit à l'utilisateur ; le message de refus reste neutre.
- Le contrôle backend est obligatoire ; masquer un bouton ne suffit pas.
- Si `docs/PERMISSIONS_APP_INTEGRATION.md` montre que la mise en place de base manque (pas de schéma, pas d'endpoint public, pas de `requirePerm`), applique sa section 4 avant la demande en cours, et dis-le.

**Si le schéma a changé**, termine ta réponse par :
« Droits mis à jour (+N clés : …). Après déploiement : Admin Panel → Profils & Droits → `regie` → Rafraîchir. »

