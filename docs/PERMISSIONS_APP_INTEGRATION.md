# Droits et profils Konitys — guide d'intégration d'une app

> **Document unique de référence** (remplace les anciens `PERMISSIONS_ARCHITECTURE_OVERVIEW.md` et `CLAUDE_PERMISSIONS_SNIPPET.md`).
> Vérifié contre le code le 2026-10-12 : gateway `plateform`, Admin Panel, apps antennes / bornes (Node + React) et qrcode (Flask).
> Complété le 2026-11-09 : apps qui ont déjà leur propre système de rôles (3.7, 4.5), périmètre « les siens / tous » (3.8), TypeScript / Next.js, app en deux dépôts, cache Keycloak (2, 7).
>
> **Public** : les développeurs d'une app Konitys **et leur Claude Code**. Le développeur lit les sections 1 à 3 ; Claude applique la section 4.

---

## 1. Pour le développeur — ce que tu as à faire (5 minutes)

1. **Copie ce fichier** dans ton dépôt : `docs/PERMISSIONS_APP_INTEGRATION.md`.
2. **Vérifie que ton app est déclarée dans le Hub** (table `apps`, avec l'URL de l'app). Sans ça, le gateway ne trouve pas ton app et bloque ses appels navigateur (CORS). En cas de doute, demande à l'administrateur de la plateforme.
3. **Ouvre Claude Code à la racine de ton app** et colle ce message :

   ```text
   Lis docs/PERMISSIONS_APP_INTEGRATION.md et applique la section 4 « Instructions pour Claude » sur cette app.
   ```

   **Si ton app a son API et son front dans deux dépôts séparés** : place ce fichier dans les deux (`docs/PERMISSIONS_APP_INTEGRATION.md`), clone-les côte à côte dans un même dossier, ouvre Claude Code **dans ce dossier parent** et colle plutôt :

   ```text
   Lis <depot-api>/docs/PERMISSIONS_APP_INTEGRATION.md et applique la section 4 « Instructions pour Claude »
   sur les deux dépôts <depot-api> et <depot-front>. Travaille sur une branche « droits-konitys » dans chacun,
   ne pousse rien.
   ```

4. **Relis et commite** ce que Claude a produit. Il te donnera la liste de ce qu'il a ajouté et les tests à faire. **Si ton app avait déjà ses propres rôles** (admin / commercial / technicien…), Claude te proposera une mise en service en deux temps (4.5) : respecte-la, sinon des utilisateurs peuvent obtenir des accès qu'ils n'avaient pas.
5. Dans l'Admin Panel → **Profils & Droits**, sélectionne ton app et clique **« Rafraîchir »** : la liste de tes droits apparaît, tu peux les cocher dans les profils.

Ensuite, **tu n'as plus rien à faire** : Claude aura ajouté à ton `CLAUDE.md` une section qui lui fait mettre à jour les droits tout seul à chaque modification (nouvelle page, nouveau bouton, nouvelle route d'écriture). Il te dira quand il faut cliquer « Rafraîchir ».

---

## 2. Comment ça marche (vue d'ensemble)

```
            Admin Panel  ─── Profils & Droits (/hub/droits) ───┐
                                                                │ lit / écrit
                                                                ▼
                     ┌──────────── GATEWAY plateform ────────────┐
                     │ profils, droits, réglage « contrôle        │
                     │ d'accès », thème de la page 403            │
                     └───┬───────────────────────────────┬───────┘
      1× au « Rafraîchir »│                               │ à chaque requête (cache 30 s)
   le gateway LIT le      │                               │ l'app DEMANDE
   schéma de l'app        ▼                               ▲ GET /api/permissions/me
            GET <app>/adminpanel/permissions-schema       │
                     ┌────────────────────────────────────┴──────┐
                     │                 TON APP                    │
                     │ • déclare ses droits (schéma JSON public)  │
                     │ • backend : requirePerm('clé') → 403 JSON  │
                     │ • frontend : masque boutons / pages        │
                     └────────────────────────────────────────────┘
```

- **L'app déclare** la liste de ses droits dans un fichier (le *schéma*), servi publiquement sur `GET /adminpanel/permissions-schema`.
- **Le gateway lit ce schéma** uniquement quand un admin clique « Rafraîchir » (ou à la première consultation si rien n'est en cache). **Il n'y a pas de rafraîchissement automatique.**
- **L'admin coche les droits** dans des profils. Les profils sont les **types d'utilisateurs** de la plateforme (table `type_profils` : « Admin », « Konitys commercial », « Installateur »…), rattachés aux comptes dans l'Admin Panel (table `user_type_profils`). Un profil peut en inclure d'autres.
- **À l'exécution**, l'app demande au gateway les droits de l'utilisateur connecté (`/api/permissions/me`), les garde 30 s en cache, et autorise ou refuse.

Trois règles valent partout et sont déjà gérées par le code de référence :

| Règle | Effet |
|---|---|
| **Admin** (rôle Keycloak realm `admin`) | Passe partout (`is_admin: true`). Ne jamais coder de cas particulier. |
| **Contrôle d'accès désactivé** pour l'app (réglage de l'Admin Panel) | Tout est autorisé, les contrôles restent dans le code mais ne bloquent rien. On peut donc livrer les contrôles sans risque. |
| **Gateway injoignable** | Tout est autorisé (*fail-open*) : une panne d'infra ne doit jamais bloquer les utilisateurs. **Exception** : le périmètre des données (« tous » contre « les siens », 3.8) est évalué en mode fermé. |

> Le statut admin vient du **jeton Keycloak**, les autres droits viennent de la base (lus à chaque appel de `/me`). Pour qu'un compte passé « Admin » dans l'Admin Panel le soit aussi dans son jeton, le connecteur Keycloak « Konitys Users (PostgreSQL) » doit être en `Cache policy = NO_CACHE`, et l'utilisateur doit se reconnecter.

---

## 3. Le contrat — ce que chaque app doit respecter

### 3.1 Le schéma des droits

Un objet JSON de cette forme exacte (l'Admin Panel refuse un schéma sans tableau `groups`) :

```json
{
  "app": "antennes",
  "label": "Antennes",
  "version": 1,
  "groups": [
    { "key": "access", "label": "Accès à l'application", "permissions": [
      { "key": "app.access", "label": "Accéder à l'application" }
    ]},
    { "key": "pages", "label": "Navigation (pages)", "permissions": [
      { "key": "pages.contacts.view", "label": "Voir la liste des contacts" }
    ]},
    { "key": "contacts", "label": "Contacts", "permissions": [
      { "key": "contacts.create", "label": "Créer un contact" },
      { "key": "contacts.delete", "label": "Supprimer un contact", "description": "Mise à la corbeille." }
    ]}
  ]
}
```

Règles :

- **`app`** = la clé de l'app (`antennes`, `bornes`, `qrcode`…). Le gateway l'enregistre comme clé officielle de l'app : **elle ne doit jamais changer**, et c'est elle qu'on utilise partout ailleurs (`APP_KEY`).
- **Groupes** : toujours `access` (avec `app.access`) et `pages` (une clé `pages.<page>.view` par page), puis un groupe par entité métier.
- **Clés** : minuscules, `snake_case`, séparées par des points : `entite.action` (`contacts.create`, `contacts.edit`, `contacts.delete`, `contacts.export`…).
- **« Les siens » / « tous »** : deux clés `historique.edit_own` et `historique.edit_any`, contrôlées avec `requireAnyPerm` puis une vérification de propriété dans le handler.
- **Libellés en français**, compréhensibles par un admin non technicien. `description` est facultatif.
- **Ne jamais supprimer ni renommer une clé** : les droits déjà cochés en base deviendraient orphelins. Une fonctionnalité retirée garde sa clé.
- **Incrémenter `version`** à chaque modification (information pour les humains : le gateway ne s'en sert pas).

### 3.2 L'endpoint public

`GET /adminpanel/permissions-schema` doit répondre **sans authentification** (le gateway l'appelle sans jeton).

- Node : dans `lib/adminpanel/index.js`, déclarer la route **avant** `router.use('/adminpanel', requireAdmin)`.
- Flask : une route sans décorateur d'authentification.

Le gateway cherche l'endpoint à partir de l'URL déclarée dans la table `apps`, en essayant dans l'ordre : l'URL elle-même, puis `<sous-domaine>-api.<domaine>`, `<sous-domaine>-gateway.<domaine>`, `api.<domaine>` ; et pour chacune les chemins `/adminpanel/permissions-schema` puis `/api/adminpanel/permissions-schema`. Si ton API n'est sur aucune de ces adresses, le « Rafraîchir » échouera.

### 3.3 Le backend

Toute route qui **écrit** (POST / PUT / PATCH / DELETE) est protégée par un droit. Les routes de lecture sensibles aussi (export, données personnelles, corbeille…).

| Outil | Usage |
|---|---|
| `requirePerm('contacts.create')` | Middleware sur une route. **Un seul argument** : la clé, sans le préfixe de l'app. |
| `requireAnyPerm('x.edit_own', 'x.edit_any')` | Passe si l'un des droits est accordé. |
| `await userCan(req, 'contacts.view_deleted')` | Vérification **dans** un handler, quand seul un paramètre est sensible (ex. `GET /contacts` ouvert à tous mais `?deleted=1` réservé). |
| Flask : `@require_perm('projects.create')` | Décorateur, placé **sous** `@app.route`. |

Refus : réponse **403 JSON** `{ "error": "Forbidden", "message": "Accès non autorisé. Contactez votre administrateur." }`. **Jamais la clé du droit dans la réponse** : elle n'apparaît que dans les logs serveur.

Les routes déjà réservées aux admins (`requireAdmin`, module `/adminpanel/*`) n'ont pas besoin de `requirePerm` en plus.

### 3.4 Le frontend

Deux variantes selon la technologie de l'app :

**A. Application React (SPA)** — cas d'antennes et bornes. Fichier `src/lib/perms.js` (code en 5.2) :

| Outil | Usage |
|---|---|
| `loadPermsSDK({ token, gatewayUrl })` | À appeler dans le Layout dès que le jeton Keycloak est disponible. Charge le SDK du gateway. |
| `<PageGuard perm="pages.contacts.view">` | Autour de chaque page dans le routeur ; renvoie sur `/403` si refusé. |
| `<Gate perm="contacts.create"><button/></Gate>` | Autour de chaque bouton ou entrée de menu sensible ; ne l'affiche pas si refusé. |
| `usePerm('contacts.edit')` | Booléen pour la logique de rendu (champ en lecture seule, colonne masquée…). |

Et une route `/403` qui affiche la page de refus (`AccessDenied`, code en 5.3), ainsi qu'un `PageGuard perm="app.access"` autour du Layout entier.

**B. Pages rendues par le serveur** (Flask / Jinja, HTML classique) — cas de qrcode :

- Attribut `data-perm="<app>:<clé>"` sur chaque bouton ou lien sensible.
- Le SDK est chargé par le header fédéré `konitys-header.js` (passer `data-app-key="<app>"` sur sa balise) ; puis, une fois la page affichée et après chaque rendu dynamique :
  `window.__KONITYS_PERMS.ready().then(() => window.__KONITYS_PERMS.gateDom(document))`.
- Les pages sont protégées côté serveur par `@require_perm('pages.x.view')`, qui renvoie la page 403 HTML (code en 5.4).

> En React, `data-perm` **ne masque rien** tout seul (`gateDom` n'est pas appelé) : utiliser `Gate` / `PageGuard` / `usePerm`. `Gate` ajoute de lui-même un `data-perm` qui sert de repère de relecture.

Masquer un bouton ne protège rien : **le contrôle backend est obligatoire**, le frontend n'est que du confort.

### 3.5 La page « Accès refusé »

Une seule apparence pour toute la plateforme, réglée dans l'Admin Panel → Apparence (`/hub/apparence`) → carte « Page « Accès refusé » » et servie par le gateway (public, sans authentification) :

- `GET <gateway>/config/deny-theme/version` → `{ version, updated_at }`
- `GET <gateway>/config/deny-theme.json` → `{ config: { page, card, icon, title, message, button }, version, updated_at }` — le thème est **dans `config`**.

Le bouton de la page suit cette règle (implémentée dans le code de référence) :

| Situation | Bouton |
|---|---|
| L'utilisateur a `<app>:app.access` (il lui manque un autre droit) | « Retour à l'accueil » → `/` |
| Il n'a pas `<app>:app.access` mais a `hub:app.access` | « Retour au Hub » → `PLATEFORM_URL` |
| Il n'a ni l'un ni l'autre | Pas de bouton |

Le texte affiché vient du thème (neutre). **Ne jamais afficher la clé du droit manquant.**

### 3.6 Variables d'environnement

| Variable | Où | Valeur DEV | Valeur PROD |
|---|---|---|---|
| `GATEWAY_URL` | backend | `https://plateform-gateway.orkessidev.com` | `https://plateform-gateway.orkessi.com` |
| `PLATEFORM_URL` | backend (Flask) | `https://plateform.orkessidev.com` | `https://plateform.orkessi.com` |
| `REACT_APP_GATEWAY_URL` / `VITE_GATEWAY_URL` | frontend React | idem `GATEWAY_URL` | idem |
| `REACT_APP_PLATEFORM_URL` / `VITE_PLATEFORM_URL` | frontend React | idem `PLATEFORM_URL` | idem |

Sans `GATEWAY_URL`, les contrôles laissent tout passer (fail-open) : c'est la première chose à vérifier si « rien ne bloque ».

Next.js : seules les variables `NEXT_PUBLIC_*` sont visibles dans le navigateur. Utiliser `NEXT_PUBLIC_GATEWAY_URL` et `NEXT_PUBLIC_PLATEFORM_URL` côté front.

### 3.7 Ce qui est interdit

Les droits d'une app viennent **uniquement** de `/api/permissions/me`. Sont donc interdits :

- un **système de rôles propre à l'app** (`role = 'ADMIN' | 'COMMERCIAL' | …` stocké dans la base de l'app et testé dans le code) ;
- **déduire des droits des rôles Keycloak**, à la seule exception de `admin`, déjà géré par `is_admin`. Les rôles Keycloak `commercial`, `projet`… sont tirés des types d'utilisateurs par une table figée dans Keycloak : ils ne suivent pas les droits cochés dans l'Admin Panel ;
- une **liste d'e-mails ou d'identifiants** autorisés (`ADMIN_EMAILS`, `if (user.id === 141)`…) ;
- une clé de droit qui décrit un rôle (`app.admin`, `app.commercial`) : une clé décrit **une action** (`ventes.view`, `lieux.edit`).

Une app qui a déjà l'un de ces mécanismes le remplace en suivant 4.5.

### 3.8 Périmètre des données : « les siens » ou « tous »

Quand un utilisateur ne doit voir qu'une partie des données (ses clients, ses lieux, ses missions…) :

- deux clés par domaine : `<entite>.view_own` et `<entite>.view_any` (même modèle que `edit_own` / `edit_any`) ;
- le filtre (« dont je suis le commercial », « rattachés à mon compte ») **reste dans le code** de l'app, avec ses données métier ; seule la **décision de filtrer** devient un droit ;
- cette décision est évaluée en **mode fermé** : sans réponse du gateway, ou si le contrôle d'accès est désactivé pour l'app, l'utilisateur ne voit que les siens. Le statut admin, lui, voit tout. Une panne ne doit jamais montrer les données des autres, surtout quand l'app a des utilisateurs externes (partenaires, clients).

Helper à ajouter à côté de `requirePerm` (5.1) :

```js
/** Périmètre : true seulement si le gateway a répondu ET (admin OU droit accordé). Jamais de fail-open. */
export async function peutVoirTout(req, permKey) {
  const me = await getMe(tokenOf(req));
  if (!me) return false;
  if (me.is_admin) return true;
  return ((me.apps || {})[APP_KEY] || {})[permKey] === true;
}

// Utilisation
const filtre = (await peutVoirTout(req, 'lieux.view_any')) ? {} : { commercialId: req.utilisateur.id };
```

Flask : même logique dans `permissions.py`, fonction `peut_voir_tout(cle)` : fausse si `/me` n'a pas répondu, vraie si admin ou si le droit est accordé, sans tenir compte du réglage « contrôle d'accès ».

---

## 4. Instructions pour Claude

> **Claude, cette section s'adresse à toi.** Applique-la entièrement, dans l'ordre, sans demander de confirmation pour les modifications locales. Ne pousse rien (pas de `git push`) et ne touche à aucun autre dépôt que ceux de l'app (son API et son front s'ils sont séparés). Les sections 3 (contrat) et 5 (code de référence) font foi : copie le code de référence et adapte uniquement ce qui est marqué `À ADAPTER`.

### 4.1 État des lieux (toujours en premier)

Détermine et note :

1. **La technologie** : backend Node/Express (JS ou TypeScript), Flask, autre ; frontend React (CRA, Vite ou Next.js), pages serveur (Jinja), autre ; un seul dépôt, ou API et front séparés.
2. **La clé de l'app** (`APP_KEY`) : celle d'un schéma existant (`"app": ...`), sinon le nom court de l'app en minuscules. Si un schéma existe déjà, **ne change jamais sa clé `app`**.
3. **Ce qui existe déjà** :
   - un schéma (fichier `permissions-schema*`, ou constante `PERMISSIONS_SCHEMA` dans le code) ;
   - l'endpoint `/adminpanel/permissions-schema` et s'il est public ;
   - un helper `requirePerm` / `require_perm` et **sa forme** : il doit appeler `GET <gateway>/api/permissions/me`. Un helper qui appelle une autre route (par exemple `/api/permissions/check`, qui n'existe pas) ou qui lit une variable locale du genre `PERMS_ENFORCE` est **à remplacer** par le code de référence ;
   - les contrôles frontend (`PageGuard`, `Gate`, `usePerm`, `data-perm` + `gateDom`) ;
   - la section « Droits Konitys » dans `CLAUDE.md` ;
   - **un mécanisme interdit par 3.7** : rôles propres à l'app (colonne `role`, middleware du genre `exiger('ADMIN')` / `requireRole(...)`, tests `role === …` dans le front), rôles Keycloak autres que `admin` lus dans le jeton (`realm_access`, `resource_access`), liste d'e-mails (`ADMIN_EMAILS`…). S'il y en a un, la section 4.5 s'applique en plus ;
   - les **filtres de périmètre** (« seulement ses clients / ses lieux… ») : ils relèvent de 3.8.
4. **La liste exhaustive** : toutes les pages (routes du frontend, entrées de menu), tous les boutons ou actions sensibles (créer, modifier, supprimer, archiver, exporter, importer, envoyer, valider…), toutes les routes API d'écriture et les lectures sensibles. Pour les routes, regarde aussi les montages (`app.use('/api/x', requireAdmin, router)`, `router.use(...)`) : une route déjà protégée au montage n'a pas besoin d'autre chose.

### 4.2 Mise en place (ne fais que ce qui manque ou ce qui est faux)

1. **Schéma** (3.1) : crée ou complète-le. Node : `lib/adminpanel/routes/permissions-schema.js` qui exporte `buildPermissionsSchema()` (ou à l'emplacement du module adminpanel de l'app). Flask : constante `PERMISSIONS_SCHEMA` dans `permissions.py`. Une clé par page, par action sensible, par route d'écriture. **N'enlève aucune clé existante.**
2. **Endpoint public** (3.2) : `GET /adminpanel/permissions-schema`, sans authentification, déclaré avant toute protection admin.
3. **Backend** (3.3) : copie le code de référence (5.1 pour Node, 5.4 pour Flask), mets la bonne `APP_KEY`, puis protège chaque route d'écriture et chaque lecture sensible avec la clé correspondante.
4. **Frontend** (3.4) :
   - React : copie `src/lib/perms.js` (5.2) et `src/pages/AccessDenied.js` (5.3) ; appelle `loadPermsSDK` dans le Layout ; ajoute la route `/403` **hors** des pages protégées ; entoure le Layout d'un `PageGuard perm="app.access"`, chaque page d'un `PageGuard perm="pages.<x>.view"`, chaque bouton sensible d'un `Gate`.
   - Pages serveur : `data-perm="<app>:<clé>"` sur les boutons, appel de `gateDom` (3.4 B), `@require_perm('pages.<x>.view')` sur chaque route de page.
   - **TypeScript** : porte fidèlement 5.1 / 5.2 / 5.3 en `.ts` / `.tsx`, sans changer la logique.
   - **Next.js (App Router)** : `src/lib/perms.tsx` avec `"use client"` ; `loadPermsSDK` dans le layout client dès que le jeton existe, puis `configure({ token })` à chaque rafraîchissement du jeton ; page de refus dans `app/403/page.tsx`, hors de tout `PageGuard` ; variables `NEXT_PUBLIC_*` (3.6).
   - **API et front dans deux dépôts** : le schéma vit dans l'**API** (c'est elle qui sert l'endpoint public) ; les pages et boutons du front y ont leurs clés.
   - **Périmètre** (3.8) : ajoute `peutVoirTout` et remplace chaque filtre « les siens » décidé par un rôle.
5. **Variables d'environnement** (3.6) : ajoute-les dans les fichiers `.env.example` (et `.env` de DEV s'il existe) ; ne mets **aucune** URL en dur dans le code.
6. **`CLAUDE.md`** : ajoute **en haut** du `CLAUDE.md` à la racine de l'app (de **chaque** dépôt si l'app en a deux) la section du 4.4, telle quelle, en remplaçant `<APP_KEY>`. Si `CLAUDE.md` ne fait qu'importer un autre fichier (par exemple `@AGENTS.md`), mets la section en haut de ce fichier-là. S'il contient déjà une ancienne section permissions (« auto-bootstrap », « Routine 1/2/3 », « Système de permissions Konitys »…), **remplace-la** par celle-ci. Si l'ancien script `scripts/audit-permissions.sh` existe, supprime-le (il n'est plus utilisé : il donnait de fausses alertes).
7. **Vérifie** (4.3), puis **termine par un compte rendu** au développeur :
   - ce qui a été ajouté ou corrigé (fichiers) ;
   - les clés du schéma créées, par groupe ;
   - les routes ou boutons que tu n'as pas su classer (à décider par le développeur) ;
   - les tests à faire de son côté (4.3, points 4 et 5) ;
   - le rappel : « Après déploiement, Admin Panel → Profils & Droits → sélectionner l'app → Rafraîchir » ;
   - si 4.5 s'applique : le tableau de correspondance, et les commits séparés en **temps 1** et **temps 2**.

### 4.3 Vérifications

1. L'app démarre / compile **sans nouvelle erreur ni nouvel avertissement** (compare avec l'état d'avant tes modifications).
2. `GET <api>/adminpanel/permissions-schema` sans jeton → `200` et un JSON avec `app` et `groups` (si l'app peut tourner en local, teste-le vraiment ; sinon vérifie le code).
3. Relis chaque fichier de routes : plus aucune route d'écriture sans contrôle (droit, ou protection admin au montage).
4. *(Développeur, après déploiement)* « Rafraîchir » dans Profils & Droits affiche bien les droits de l'app.
5. *(Développeur)* Avec le contrôle d'accès **activé** pour l'app et un compte **non admin** dont le profil n'a pas un droit : le bouton disparaît, la page renvoie sur la page de refus, l'appel API répond 403. Avec le contrôle **désactivé** : tout fonctionne comme avant.

### 4.4 Section à mettre dans le `CLAUDE.md` de l'app

Copie ce bloc tel quel (remplace seulement `<APP_KEY>`) :

````markdown
## 🔐 Droits Konitys — à appliquer à CHAQUE modification (obligatoire)

Cette app expose ses droits à l'Admin Panel Konitys (clé d'app : `<APP_KEY>`).
Référence complète : `docs/PERMISSIONS_APP_INTEGRATION.md`.

**Avant de terminer toute tâche qui modifie le code**, relis UNIQUEMENT ce que tu viens de changer et applique :

| Tu as ajouté… | Tu dois… |
|---|---|
| une route API qui écrit (POST/PUT/PATCH/DELETE) ou une lecture sensible | la protéger : `requirePerm('<entite>.<action>')` (Flask : `@require_perm(...)` sous `@app.route`), sauf si elle est déjà réservée aux admins au montage |
| un bouton / une action sensible (créer, modifier, supprimer, exporter, envoyer…) | React : l'entourer de `<Gate perm="...">` ou utiliser `usePerm` ; pages serveur : `data-perm="<APP_KEY>:<clé>"` |
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
« Droits mis à jour (+N clés : …). Après déploiement : Admin Panel → Profils & Droits → `<APP_KEY>` → Rafraîchir. »
````

### 4.5 L'app a déjà son propre système de rôles (migration)

À appliquer en plus de 4.2 quand l'état des lieux (4.1) a trouvé un mécanisme interdit par 3.7.

1. **Inventaire** : chaque contrôle de rôle de l'API (routes **et** montages `app.use(..., controle, router)`), chaque filtre de périmètre, chaque test de rôle du front, avec le ou les rôles autorisés aujourd'hui.
2. **Clés** : une clé par action (3.1), jamais une clé par rôle. Au montage d'un routeur réservé à certains rôles, une clé de lecture du domaine (`ventes.view`), plus une clé par route d'écriture.
3. **Tableau de correspondance** : pour chaque rôle actuel, les clés qui reproduisent **exactement** ses accès d'aujourd'hui. L'admin s'en sert pour cocher les profils sans rien changer pour les utilisateurs. Mets-le dans le compte rendu et dans `docs/droits-correspondance-roles.md`.
4. **Retraits**, une fois tout remplacé : le middleware de rôles, les tests de rôle du front, la lecture des rôles Keycloak autres que `admin`, les listes d'e-mails et leurs variables d'environnement (retire-les aussi des `.env.example`). **Ne supprime aucune colonne** (`role`…) : arrête seulement de t'en servir pour autoriser, et signale-la. Un écran de l'app qui servait à choisir le rôle d'un utilisateur ne le permet plus (les droits se gèrent dans l'Admin Panel) ; garde ses autres fonctions.
5. **Deux temps de déploiement**, à préparer en commits séparés. Il ne doit jamais y avoir de moment où les rôles ne protègent plus et où les droits ne protègent pas encore :
   - **Temps 1** : schéma, endpoint public et `CLAUDE.md` seulement ; les anciens contrôles restent actifs. Après déploiement, l'admin clique « Rafraîchir », coche les droits des profils d'après le tableau et rattache les profils aux comptes.
   - **Temps 2** : le reste (`requirePerm`, front, retraits). Au même moment, l'admin **active le contrôle d'accès pour l'app** dans l'Admin Panel. Tant qu'il est désactivé, toutes les actions sont autorisées à tout le monde.
   - DEV d'abord, avec un compte de chaque ancien rôle, puis PROD.

---

## 5. Code de référence

Copié des apps en production (antennes pour Node / React, qrcode pour Flask). Les seules lignes à modifier sont marquées `À ADAPTER`.

### 5.1 Node / Express — `api/middleware/permissions.js`

Fonctionne avec Node 18+ (`fetch` natif). Pour une API en CommonJS, remplacer les `export` par `module.exports`.

```js
// Droits Konitys — voir docs/PERMISSIONS_APP_INTEGRATION.md
// Interroge le gateway (/api/permissions/me) avec le jeton de l'utilisateur,
// cache 30 s par jeton, applique le réglage « contrôle d'accès », fail-open.

const APP_KEY = 'antennes'; // À ADAPTER : clé "app" du schéma
const CACHE_TTL_MS = 30_000;
const GATEWAY_URL = (process.env.GATEWAY_URL || '').replace(/\/$/, '');

const _cache = new Map(); // jeton → { at, data }

async function loadMe(token) {
  if (!token || !GATEWAY_URL) return null;
  try {
    const res = await fetch(`${GATEWAY_URL}/api/permissions/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data || null;
  } catch (e) {
    console.warn('[perms] gateway injoignable :', e.message);
    return null;
  }
}

async function getMe(token) {
  if (!token) return null;
  const now = Date.now();
  const cached = _cache.get(token);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.data;
  const data = await loadMe(token);
  if (data) _cache.set(token, { at: now, data });
  return data;
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// Réglage « contrôle d'accès » de l'Admin Panel (5 champs, voir 6.2)
function isEnforced(e, appKey) {
  if (!e) return false;
  if (e.globally_enabled) {
    if (e.disable_specific && (e.disabled_apps || []).includes(appKey)) return false;
    return true;
  }
  return !!(e.enable_specific && (e.enabled_apps || []).includes(appKey));
}

export function canForApp(me, appKey, permKey) {
  if (!me) return true;              // fail-open
  if (me.is_admin) return true;      // admins Keycloak
  if (!isEnforced(me.enforcement || {}, appKey)) return true;
  return !!((me.apps || {})[appKey] || {})[permKey];
}

const DENIED = { error: 'Forbidden', message: 'Accès non autorisé. Contactez votre administrateur.' };

/** Middleware : requirePerm('contacts.create') */
export function requirePerm(permKey) {
  return async (req, res, next) => {
    const token = tokenOf(req);
    const me = await getMe(token);
    if (me === null && token) return next(); // gateway injoignable → fail-open
    if (canForApp(me, APP_KEY, permKey)) return next();
    console.log(`[perms] ${APP_KEY}:${permKey} → REFUS (user=${req.user?.email || '?'})`);
    return res.status(403).json(DENIED);
  };
}

/** Middleware : requireAnyPerm('historique.edit_own', 'historique.edit_any') */
export function requireAnyPerm(...permKeys) {
  return async (req, res, next) => {
    const token = tokenOf(req);
    const me = await getMe(token);
    if (me === null && token) return next();
    if (permKeys.some((k) => canForApp(me, APP_KEY, k))) return next();
    console.log(`[perms] ${APP_KEY}:[${permKeys.join('|')}] → REFUS (user=${req.user?.email || '?'})`);
    return res.status(403).json(DENIED);
  };
}

/** Vérification dans un handler : if (!(await userCan(req, 'contacts.view_deleted'))) return res.status(403).json(...) */
export async function userCan(req, permKey) {
  const token = tokenOf(req);
  const me = await getMe(token);
  if (me === null && token) return true;
  return canForApp(me, APP_KEY, permKey);
}

export function invalidatePermsCache() { _cache.clear(); }
export { APP_KEY };
export default requirePerm;
```

Utilisation :

```js
import { requirePerm, requireAnyPerm, userCan } from '../middleware/permissions.js';

router.post('/contacts', requirePerm('contacts.create'), createContact);
router.delete('/contacts/:id', requirePerm('contacts.delete'), deleteContact);
router.put('/historique/:id', requireAnyPerm('historique.edit_own', 'historique.edit_any'), updateHistorique);
```

Schéma et endpoint public — `lib/adminpanel/routes/permissions-schema.js` puis `lib/adminpanel/index.js` :

```js
// lib/adminpanel/routes/permissions-schema.js
export function buildPermissionsSchema() {
  return {
    app: 'antennes',          // À ADAPTER
    label: 'Antennes',        // À ADAPTER
    version: 1,
    groups: [ /* voir 3.1 */ ],
  };
}
```

```js
// lib/adminpanel/index.js — la route publique AVANT router.use('/adminpanel', requireAdmin)
import { buildPermissionsSchema } from './routes/permissions-schema.js';
// … dans la fabrique du router :
router.get('/adminpanel/permissions-schema', (_req, res) => res.json(buildPermissionsSchema()));
router.use('/adminpanel', requireAdmin);
```

### 5.2 React — `src/lib/perms.js`

Pour Vite : renommer en `.jsx` et lire `import.meta.env.VITE_GATEWAY_URL` au lieu de `process.env.REACT_APP_GATEWAY_URL`.

```jsx
// Droits Konitys côté React — s'appuie sur le SDK du gateway (window.__KONITYS_PERMS).
// Tout est « autorisé » le temps que le SDK charge, pour éviter un écran vide.

import React, { useEffect, useState, cloneElement, isValidElement } from 'react';
import { Navigate } from 'react-router-dom';

const APP_KEY = 'antennes'; // À ADAPTER : clé "app" du schéma
let _sdkLoaded = false;

export function loadPermsSDK({ token, gatewayUrl }) {
  if (!token || !gatewayUrl) return;
  if (_sdkLoaded && window.__KONITYS_PERMS) {
    window.__KONITYS_PERMS.configure({ token });
    window.__KONITYS_PERMS.refresh();
    return;
  }
  _sdkLoaded = true;
  window.__KONITYS_AUTH = { token };
  const s = document.createElement('script');
  s.src = `${gatewayUrl.replace(/\/$/, '')}/sdk/konitys-perms.js?t=${Date.now()}`;
  s.setAttribute('data-gateway', gatewayUrl);
  s.setAttribute('data-token', token);
  s.setAttribute('data-app', APP_KEY);   // attribut lu par le SDK : data-app
  s.async = true;
  document.body.appendChild(s);
}

function getSDK() { return typeof window !== 'undefined' ? window.__KONITYS_PERMS : null; }

export function usePerm(permKey) {
  const [sdk, setSdk] = useState(getSDK());
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!sdk) {
      const iv = setInterval(() => {
        const cur = getSDK();
        if (cur) { clearInterval(iv); setSdk(cur); }
      }, 100);
      return () => clearInterval(iv);
    }
    return sdk.onChange(() => setTick((t) => t + 1));
  }, [sdk]);
  if (!sdk || !permKey) return true;
  return sdk.has(permKey);
}

export function Gate({ perm, children, fallback = null }) {
  const allowed = usePerm(perm);
  if (!allowed) return fallback;
  if (isValidElement(children)) {
    const existing = children.props['data-perm'];
    return cloneElement(children, { 'data-perm': existing || `${APP_KEY}:${perm}` });
  }
  return children;
}

export function PageGuard({ perm, children }) {
  const allowed = usePerm(perm);
  if (!allowed) return <Navigate to="/403" replace />;
  return children;
}

export { APP_KEY };
```

Branchement :

```jsx
// Layout — dès que le jeton Keycloak est disponible
useEffect(() => {
  if (auth.user?.access_token) {
    const gw = process.env.REACT_APP_GATEWAY_URL || '';
    if (gw) loadPermsSDK({ token: auth.user.access_token, gatewayUrl: gw });
  }
}, [auth.user?.access_token]);

// Routeur
<Route path="/403" element={<AccessDenied />} />              {/* hors des pages protégées */}
<Route path="/" element={<PageGuard perm="app.access"><Layout /></PageGuard>}>
  <Route path="contacts" element={<PageGuard perm="pages.contacts.view"><Contacts /></PageGuard>} />
</Route>

// Bouton
<Gate perm="contacts.create"><button onClick={openCreate}>Nouveau contact</button></Gate>
```

Le SDK accepte une clé simple (`'contacts.create'`, pour l'app courante) ou préfixée (`'hub:app.access'`, pour une autre app).

### 5.3 React — `src/pages/AccessDenied.js`

```jsx
// Page « Accès refusé » — thème partagé servi par le gateway. N'affiche jamais la clé du droit.
import React, { useEffect, useState } from 'react';

const APP_KEY = 'antennes'; // À ADAPTER
const GATEWAY = (process.env.REACT_APP_GATEWAY_URL || '').replace(/\/$/, '');     // Vite : import.meta.env.VITE_GATEWAY_URL
const PLATEFORM = (process.env.REACT_APP_PLATEFORM_URL || '').replace(/\/$/, ''); // Vite : import.meta.env.VITE_PLATEFORM_URL

const ICONS = {
  lock:    <><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>,
  shield:  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>,
  ban:     <><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></>,
  alert:   <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
  xcircle: <><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></>,
};
const SHADOWS = {
  none: 'none',
  light: '0 4px 12px rgba(15,23,42,0.04)',
  medium: '0 20px 50px rgba(15,23,42,0.08), 0 2px 8px rgba(15,23,42,0.04)',
  heavy: '0 30px 80px rgba(15,23,42,0.15), 0 8px 20px rgba(15,23,42,0.08)',
};
const DEFAULT_THEME = {
  page: { bg_from: '#eef4fb', bg_to: '#e0e7ff', padding: 24 },
  card: { bg: '#ffffff', radius: 20, shadow: 'medium', padding_y: 40, padding_x: 40 },
  icon: { preset: 'lock', size: 88, bg_from: '#fef2f2', bg_to: '#fee2e2', color: '#dc2626', radius: 50, dashed_border: true },
  title: { text: 'Accès non autorisé', color: '#0f172a', size: 22, weight: 700, letter_spacing: -0.01 },
  message: { text: 'Votre compte ne dispose pas des droits nécessaires pour accéder à cette ressource. Contactez votre administrateur pour obtenir les autorisations requises.', color: '#64748b', size: 14 },
  button: { bg: '#6366f1', bg_hover: '#4f46e5', color: '#ffffff', radius: 10, shadow: true },
};

function resolveRedirect() {
  const sdk = window.__KONITYS_PERMS;
  if (!sdk || sdk.has(`${APP_KEY}:app.access`)) return { url: '/', label: "Retour à l'accueil" };
  if (PLATEFORM && sdk.has('hub:app.access')) return { url: PLATEFORM, label: 'Retour au Hub' };
  return { url: null, label: null };
}

export default function AccessDenied() {
  const [t, setTheme] = useState(DEFAULT_THEME);
  const [redirect, setRedirect] = useState({ url: '/', label: "Retour à l'accueil" });

  useEffect(() => {
    if (!GATEWAY) return;
    fetch(`${GATEWAY}/config/deny-theme.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.config) setTheme({ ...DEFAULT_THEME, ...d.config }); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // le SDK peut finir de charger après l'affichage de la page
    const tryResolve = () => { if (window.__KONITYS_PERMS) setRedirect(resolveRedirect()); };
    tryResolve();
    const iv = setInterval(tryResolve, 150);
    const to = setTimeout(() => clearInterval(iv), 4000);
    return () => { clearInterval(iv); clearTimeout(to); };
  }, []);

  const size = Math.round(t.icon.size * 0.45);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: t.page.padding, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      background: `linear-gradient(135deg, ${t.page.bg_from} 0%, ${t.page.bg_to} 100%)` }}>
      <div style={{ background: t.card.bg, borderRadius: t.card.radius, boxShadow: SHADOWS[t.card.shadow] || SHADOWS.medium,
        padding: `${t.card.padding_y}px ${t.card.padding_x}px`, maxWidth: 440, width: '100%', textAlign: 'center' }}>
        <div style={{ position: 'relative', display: 'inline-flex', margin: '0 auto 24px' }}>
          <div style={{ width: t.icon.size, height: t.icon.size, borderRadius: `${t.icon.radius}%`, color: t.icon.color,
            background: `linear-gradient(135deg, ${t.icon.bg_from} 0%, ${t.icon.bg_to} 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {ICONS[t.icon.preset] || ICONS.lock}
            </svg>
          </div>
          {t.icon.dashed_border && (
            <span style={{ position: 'absolute', inset: -6, borderRadius: `${t.icon.radius}%`,
              border: `2px dashed ${t.icon.color}55`, opacity: 0.6, pointerEvents: 'none' }} />
          )}
        </div>
        <h1 style={{ margin: '0 0 12px', fontSize: t.title.size, fontWeight: t.title.weight, color: t.title.color,
          letterSpacing: `${t.title.letter_spacing}em` }}>{t.title.text}</h1>
        <p style={{ margin: '0 0 28px', color: t.message.color, fontSize: t.message.size, lineHeight: 1.6 }}>{t.message.text}</p>
        {redirect.url && (
          <a href={redirect.url} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 22px',
            background: t.button.bg, color: t.button.color, textDecoration: 'none', borderRadius: t.button.radius,
            fontWeight: 600, fontSize: 14, boxShadow: t.button.shadow ? `0 4px 12px ${t.button.bg}44` : 'none' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
            </svg>
            {redirect.label}
          </a>
        )}
      </div>
    </div>
  );
}
```

### 5.4 Python / Flask — `permissions.py`

Le jeton Keycloak de l'utilisateur doit être en session (`session['access_token']`) — à adapter si l'app le range ailleurs.

```python
# Droits Konitys — voir docs/PERMISSIONS_APP_INTEGRATION.md
import os, time, json, threading, requests
from functools import wraps
from flask import session, jsonify, request, render_template_string

APP_KEY = 'qrcode'   # À ADAPTER : clé "app" du schéma
HUB_APP_KEY = 'hub'
GATEWAY_URL = os.environ.get('GATEWAY_URL', '').rstrip('/')
PLATEFORM_URL = os.environ.get('PLATEFORM_URL', '').rstrip('/')
CACHE_TTL = 30.0
_cache = {}  # jeton → { at, data }

PERMISSIONS_SCHEMA = {
    'app': APP_KEY,
    'label': 'QR Code',   # À ADAPTER
    'version': 1,
    'groups': [ ],        # voir 3.1
}

# ── Thème de la page de refus (cache disque + mémoire, vérif. de version toutes les 5 min)
THEME_CACHE_FILE = os.path.join(os.environ.get('DATA_DIR', '/app/data'), 'deny-theme.json')  # À ADAPTER : dossier persistant
THEME_VERSION_TTL = 300
_theme = {'config': None, 'version': 0, 'last_check_at': 0.0, 'lock': threading.Lock()}

DEFAULT_THEME = {
    'page': {'bg_from': '#eef4fb', 'bg_to': '#e0e7ff', 'padding': 24},
    'card': {'bg': '#ffffff', 'radius': 20, 'shadow': 'medium', 'padding_y': 40, 'padding_x': 40},
    'icon': {'preset': 'lock', 'size': 88, 'bg_from': '#fef2f2', 'bg_to': '#fee2e2', 'color': '#dc2626', 'radius': 50, 'dashed_border': True},
    'title': {'text': 'Accès non autorisé', 'color': '#0f172a', 'size': 22, 'weight': 700, 'letter_spacing': -0.01},
    'message': {'text': "Votre compte ne dispose pas des droits nécessaires pour accéder à cette ressource. Contactez votre administrateur pour obtenir les autorisations requises.", 'color': '#64748b', 'size': 14},
    'button': {'bg': '#6366f1', 'bg_hover': '#4f46e5', 'color': '#ffffff', 'radius': 10, 'shadow': True},
}
ICON_PRESETS = {
    'lock':    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    'shield':  '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    'ban':     '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    'alert':   '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'xcircle': '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
}
SHADOW_CSS = {
    'none': 'none',
    'light': '0 4px 12px rgba(15,23,42,0.04)',
    'medium': '0 20px 50px rgba(15,23,42,0.08), 0 2px 8px rgba(15,23,42,0.04)',
    'heavy': '0 30px 80px rgba(15,23,42,0.15), 0 8px 20px rgba(15,23,42,0.08)',
}

def _current_theme():
    now = time.time()
    if _theme['config'] is None:
        try:
            with open(THEME_CACHE_FILE, encoding='utf-8') as f:
                d = json.load(f)
            _theme['config'], _theme['version'] = d.get('config') or DEFAULT_THEME, int(d.get('version') or 0)
        except Exception:
            _theme['config'], _theme['version'] = DEFAULT_THEME, 0
    if GATEWAY_URL and now - _theme['last_check_at'] >= THEME_VERSION_TTL:
        with _theme['lock']:
            if now - _theme['last_check_at'] >= THEME_VERSION_TTL:
                _theme['last_check_at'] = now
                try:
                    v = int(requests.get(f'{GATEWAY_URL}/config/deny-theme/version', timeout=3).json().get('version') or 0)
                    if v > _theme['version']:
                        full = requests.get(f'{GATEWAY_URL}/config/deny-theme.json', timeout=5).json()
                        _theme['config'], _theme['version'] = full.get('config') or DEFAULT_THEME, int(full.get('version') or v)
                        os.makedirs(os.path.dirname(THEME_CACHE_FILE), exist_ok=True)
                        with open(THEME_CACHE_FILE, 'w', encoding='utf-8') as f:
                            json.dump({'config': _theme['config'], 'version': _theme['version']}, f, ensure_ascii=False)
                except Exception as e:
                    print(f'[theme] synchro impossible : {e}')
    return _theme['config'] or DEFAULT_THEME

# ── Droits de l'utilisateur
def _get_me():
    token = session.get('access_token', '')   # À ADAPTER si le jeton est rangé ailleurs
    if not token or not GATEWAY_URL:
        return None
    now = time.time()
    c = _cache.get(token)
    if c and now - c['at'] < CACHE_TTL:
        return c['data']
    try:
        r = requests.get(f'{GATEWAY_URL}/api/permissions/me', headers={'Authorization': f'Bearer {token}'}, timeout=5)
        data = (r.json().get('data') or {}) if r.status_code == 200 else None
    except Exception:
        data = None
    if data is not None:
        _cache[token] = {'at': now, 'data': data}
    return data

def _is_enforced(e, app_key):
    if not e:
        return False
    if e.get('globally_enabled'):
        return not (e.get('disable_specific') and app_key in (e.get('disabled_apps') or []))
    return bool(e.get('enable_specific') and app_key in (e.get('enabled_apps') or []))

def _can_for_app(me, app_key, perm_key):
    if not me or me.get('is_admin'):
        return True   # fail-open / admin
    if not _is_enforced(me.get('enforcement') or {}, app_key):
        return True
    return bool((me.get('apps') or {}).get(app_key, {}).get(perm_key))

def can(perm_key):
    """Utilisable dans le code et les templates : can('projects.create')."""
    return _can_for_app(_get_me(), APP_KEY, perm_key)

def _redirect_on_denial(me, perm_key):
    if perm_key == 'app.access' or not _can_for_app(me, APP_KEY, 'app.access'):
        if PLATEFORM_URL and _can_for_app(me, HUB_APP_KEY, 'app.access'):
            return PLATEFORM_URL, 'Retour au Hub'
        return None, None
    return '/', "Retour à l'accueil"

_DENIED_HTML = """<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ t.title.text }}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:{{ t.page.padding }}px;background:linear-gradient(135deg,{{ t.page.bg_from }} 0%,{{ t.page.bg_to }} 100%);color:{{ t.title.color }}}
.card{background:{{ t.card.bg }};border-radius:{{ t.card.radius }}px;padding:{{ t.card.padding_y }}px {{ t.card.padding_x }}px;max-width:440px;width:100%;text-align:center;box-shadow:{{ shadow_css }}}
.icon-wrap{width:{{ t.icon.size }}px;height:{{ t.icon.size }}px;border-radius:{{ t.icon.radius }}%;background:linear-gradient(135deg,{{ t.icon.bg_from }} 0%,{{ t.icon.bg_to }} 100%);margin:0 auto 24px;display:flex;align-items:center;justify-content:center;position:relative;color:{{ t.icon.color }}}
{% if t.icon.dashed_border %}.icon-wrap::before{content:'';position:absolute;inset:-6px;border-radius:{{ t.icon.radius }}%;border:2px dashed {{ t.icon.color }}55;opacity:.6}{% endif %}
.icon-wrap svg{width:{{ (t.icon.size * 0.45)|int }}px;height:{{ (t.icon.size * 0.45)|int }}px}
h1{font-size:{{ t.title.size }}px;font-weight:{{ t.title.weight }};margin-bottom:12px;color:{{ t.title.color }};letter-spacing:{{ t.title.letter_spacing }}em}
p{color:{{ t.message.color }};font-size:{{ t.message.size }}px;line-height:1.6;margin-bottom:28px}
a{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;background:{{ t.button.bg }};color:{{ t.button.color }};text-decoration:none;border-radius:{{ t.button.radius }}px;font-weight:600;font-size:14px;transition:all .15s{% if t.button.shadow %};box-shadow:0 4px 12px {{ t.button.bg }}40{% endif %}}
a:hover{background:{{ t.button.bg_hover }};transform:translateY(-1px)}
a svg{width:16px;height:16px}
</style></head>
<body><div class="card">
<div class="icon-wrap"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{{ icon_svg|safe }}</svg></div>
<h1>{{ t.title.text }}</h1>
<p>{{ t.message.text }}</p>
{% if redirect_url %}<a href="{{ redirect_url }}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>{{ redirect_label }}</a>{% endif %}
</div></body></html>"""

def require_perm(perm_key):
    """Décorateur, à placer SOUS @app.route. 403 JSON pour l'API, page HTML pour une page."""
    def deco(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if can(perm_key):
                return fn(*args, **kwargs)
            print(f'[perms] {APP_KEY}:{perm_key} → REFUS')
            wants_json = (request.path.startswith('/api/')
                          or 'application/json' in (request.headers.get('Accept') or '')
                          or request.headers.get('X-Requested-With') == 'XMLHttpRequest')
            if wants_json:
                return jsonify({'error': 'Forbidden', 'message': "Accès non autorisé. Contactez votre administrateur."}), 403
            remote = _current_theme()
            t = {k: {**DEFAULT_THEME[k], **(remote.get(k) or {})} for k in DEFAULT_THEME}  # thème incomplet → valeurs par défaut
            url, label = _redirect_on_denial(_get_me(), perm_key)
            return render_template_string(_DENIED_HTML, t=t,
                icon_svg=ICON_PRESETS.get(t['icon'].get('preset'), ICON_PRESETS['lock']),
                shadow_css=SHADOW_CSS.get(t['card'].get('shadow'), SHADOW_CSS['medium']),
                redirect_url=url, redirect_label=label), 403
        return wrapped
    return deco
```

Utilisation :

```python
from permissions import require_perm, can, PERMISSIONS_SCHEMA

@app.route('/adminpanel/permissions-schema')        # PUBLIC : aucun décorateur d'authentification
def permissions_schema():
    return jsonify(PERMISSIONS_SCHEMA)

@app.route('/codes')
@require_perm('pages.codes.view')
def codes_page(): ...

@app.route('/api/projects', methods=['POST'])
@require_perm('projects.create')
def create_project(): ...

app.jinja_env.globals['can'] = can   # dans un template : {% if can('projects.delete') %}…{% endif %}
```

---

## 6. Référence technique

### 6.1 Endpoints du gateway

Base : DEV `https://plateform-gateway.orkessidev.com` — PROD `https://plateform-gateway.orkessi.com`. Routes sous `/api/permissions`, authentifiées par le jeton Keycloak ; les écritures exigent le rôle `admin`.

| Méthode | Chemin | Usage |
|---|---|---|
| GET | `/api/permissions/me` | **Le seul appel dont une app a besoin** : droits de l'utilisateur + réglage du contrôle d'accès |
| GET | `/api/permissions/apps` | Apps connues et leur clé |
| POST | `/api/permissions/apps/:app_key/refresh` | Relit le schéma de l'app (bouton « Rafraîchir ») |
| GET | `/api/permissions/apps/:app_key/schema` | Schéma en cache (lu à la volée si absent) |
| GET / PUT | `/api/permissions/enforcement` | Réglage du contrôle d'accès |
| GET / POST | `/api/permissions/profiles` | Profils |
| PATCH / DELETE | `/api/permissions/profiles/:id` | Modifier / supprimer un profil |
| GET / PUT | `/api/permissions/profiles/:id/permissions` | Droits d'un profil (`{ app_key, grants: { clé: bool } }`) |
| GET / PUT | `/api/permissions/profiles/:id/composition` | Profils inclus dans un profil |
| GET | `/api/permissions/audit` | Journal des modifications |

Publics (sans authentification) : `/config/deny-theme/version`, `/config/deny-theme.json`, `/sdk/konitys-perms.js`, `/sdk/konitys-header.js`.

> Il n'existe **pas** de route `/api/permissions/check` : un helper qui l'appelle reçoit toujours une erreur et laisse donc tout passer.

### 6.2 Réponse de `/api/permissions/me`

```json
{
  "data": {
    "user_id": "141",
    "apps": {
      "antennes": { "app.access": true, "contacts.create": true, "contacts.delete": false },
      "hub":      { "app.access": true }
    },
    "is_admin": false,
    "profiles": [3, 8],
    "enforcement": {
      "globally_enabled": true,
      "disable_specific": true,
      "disabled_apps": ["qrcode"],
      "enable_specific": false,
      "enabled_apps": []
    }
  }
}
```

Contrôle d'accès actif pour une app :
- si `globally_enabled` : oui, **sauf** si `disable_specific` et l'app est dans `disabled_apps` (app « en mode dev ») ;
- sinon : seulement si `enable_specific` et l'app est dans `enabled_apps`.

### 6.3 SDK navigateur `window.__KONITYS_PERMS`

Chargé depuis `<gateway>/sdk/konitys-perms.js` (par `loadPermsSDK` en React, ou automatiquement par `konitys-header.js`). Attributs de la balise : `data-gateway`, `data-token`, **`data-app`**.

`ready()`, `refresh()`, `has(clé)`, `any(...clés)`, `all(...clés)`, `isEnforced(app)`, `gateDom(racine)`, `onChange(fn)`, `configure({ token })`, `state`.
Clés acceptées : `'contacts.create'` (app courante) ou `'antennes:contacts.create'`.
`gateDom` masque (`display:none`) les éléments `data-perm` refusés.

### 6.4 Admin Panel

Profils & Droits : DEV `https://adminpanel.orkessidev.com/hub/droits` — PROD `https://adminpanel.orkessi.com/hub/droits`.
Le réglage « Contrôle d'accès » (global, ou app par app) est en haut de cette page.

---

## 7. Dépannage

| Symptôme | Cause probable |
|---|---|
| « Rafraîchir » ne trouve pas le schéma | Endpoint protégé par une authentification, ou API hors des adresses essayées (3.2), ou app absente de la table `apps`. Tester : `curl <api>/adminpanel/permissions-schema`. |
| Rien n'est jamais bloqué | Contrôle d'accès désactivé pour l'app (normal), compte admin (normal), `GATEWAY_URL` absent, ou helper qui n'appelle pas `/api/permissions/me`. |
| Erreurs CORS sur `/api/permissions/me` dans le navigateur | L'URL de l'app n'est pas déclarée dans la table `apps` du Hub. |
| Un droit coché ne s'applique pas tout de suite | Cache de 30 s côté app : attendre, ou se reconnecter. |
| Un droit a disparu de l'Admin Panel | Clé supprimée du schéma : la remettre. |
| Utilisateur renvoyé sur la page de refus dès l'ouverture | Son profil n'a pas `app.access` pour l'app, alors que le contrôle d'accès est actif. |
| Compte passé « Admin » dans l'Admin Panel mais pas traité en admin | `is_admin` vient du jeton Keycloak : connecteur Keycloak pas en `NO_CACHE`, ou utilisateur pas reconnecté (2). |
| Les droits cochés n'ont aucun effet sur une app | L'app décide encore avec ses propres rôles ou avec les rôles Keycloak (3.7) : appliquer 4.5. |
| Un utilisateur voit les données des autres pendant une panne | Filtre de périmètre fait avec `userCan` (fail-open) au lieu de `peutVoirTout` (3.8). |
