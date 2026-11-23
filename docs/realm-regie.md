# Comptes clients de la Régie : realm Keycloak « regie »

Décision du 20/11/2026 (option 2 « Régie autonome ») : les clients de la Régie (gérants de lieux, comptabilité d'une
entreprise cliente…) se connectent par un **realm Keycloak à eux**, séparé des salariés. Un client connecté n'a donc
aucune session dans le realm `konitys` et ne peut ouvrir aucune autre app interne.

- **Comptes** : créés par la Régie (page *Entreprises*, ou *Mon entreprise* pour un client admin), qui envoie l'e-mail d'invitation. Le client choisit lui-même son mot de passe.
- **Droits** : toujours définis dans l'Admin Panel. Un compte client reçoit un **profil** (par exemple « Client – chiffres », « Client – admin »). La Régie lit les droits de ce profil et les applique elle-même, en **refusant par défaut**.
- **Lieux visibles** : ceux de son entreprise, ou une partie d'entre eux.
- **Ce qui ne change pas** : les salariés et les apporteurs d'affaires restent dans le realm `konitys`, comme aujourd'hui.

Ce document liste ce qu'il faut créer, puis les variables à poser dans Coolify. Rien de secret ne va dans le code ni
dans ce dépôt.

---

## 1. Keycloak (à faire par l'admin Keycloak) — DEV puis PROD

Même serveur Keycloak que les salariés (`KEYCLOAK_URL`), nouveau realm.

### 1.1 Realm `regie`
| Réglage | Valeur |
|---|---|
| Nom | `regie` |
| Inscription libre (*User registration*) | **désactivée** (seule la Régie crée les comptes) |
| Connexion par e-mail (*Login with email*) | activée ; *Email as username* activé |
| Mot de passe oublié (*Forgot password*) | activé |
| Vérification de l'e-mail (*Verify email*) | activée |
| *Remember me* | au choix (conseillé : activé) |
| SMTP (*Email*) | l'expéditeur Selfizee habituel (l'invitation et le mot de passe oublié partent d'ici) |
| Thème de connexion | logo et couleurs Selfizee / Régie (« domaine et logo de la régie ») |
| Politique de mot de passe | au moins celle du realm `konitys` |
| Durées de session | comme `konitys` |

### 1.2 Client public `regie-selfizee` (dans le realm `regie`)
Le front s'y connecte quand l'e-mail tapé à l'accueil a un compte client actif.

| Réglage | Valeur |
|---|---|
| Client ID | `regie-selfizee` |
| Client authentication | **off** (client public) |
| Standard flow | on ; Direct access grants : off |
| Valid redirect URIs | `https://regie-selfizee.orkessidev.com/*` (DEV), l'URL PROD du front `/*` |
| Web origins | les mêmes domaines (sans `/*`) |
| PKCE | `S256` (*Advanced → Proof Key for Code Exchange*) |
| Client scopes par défaut | `email`, `profile` (l'API a besoin de l'e-mail dans le jeton) |

### 1.3 Client confidentiel `regie-api` (dans le realm `regie`)
L'API de la Régie l'utilise pour créer les comptes, envoyer les invitations, activer ou désactiver un compte.

| Réglage | Valeur |
|---|---|
| Client ID | `regie-api` |
| Client authentication | **on** (confidentiel) |
| Standard flow / Direct access | off |
| Service accounts | **on** |
| Rôles du compte de service | client `realm-management` → `manage-users`, `view-users` (rien d'autre) |

Récupérer son secret (*Credentials*) et le poser dans Coolify (`KEYCLOAK_REGIE_ADMIN_CLIENT_SECRET`), jamais ailleurs.

---

## 2. Plateforme (équipe Admin Panel / gateway)

Les comptes clients n'existent pas dans le realm `konitys` : le gateway ne peut pas leur répondre sur
`/api/permissions/me`. La Régie lit donc elle-même **les droits du profil** attribué au compte, avec un compte de service.

### 2.1 Client confidentiel `regie-droits` (dans le realm **`konitys`**)
| Réglage | Valeur |
|---|---|
| Client ID | `regie-droits` |
| Client authentication | on ; Service accounts : on ; Standard flow : off |
| Rôles | aucun rôle d'écriture (surtout pas `admin`) |

### 2.2 Lecture des droits sur le gateway (réponse de la plateforme du 23/11/2026)
Le jeton du compte de service est **accepté** : sur ces routes le gateway vérifie seulement la signature (clés du realm
`konitys`) et l'émetteur (`iss`). Aucun rôle n'est demandé.

| Route | Usage par la Régie |
|---|---|
| `GET /api/permissions/profiles` | nom des profils (choix du profil d'un compte client) |
| `GET /api/permissions/profiles/:id/permissions` | droits du profil, **hérités compris** (`?app_key=` est ignoré, on lit `data.direct.regie` et `data.inherited.regie`) |
| `GET /api/permissions/profiles/:id/composition` | profils inclus directs `{ id, nom, alias }` (information seulement : les hérités sont déjà dans `/permissions`) |

Forme de `/permissions` : `{ data: { direct: { regie: { clé: true | false } }, inherited: { regie: { clé: [ { id, name } ] } } } }`.
Un droit est effectif s'il vaut `true` dans `direct` ou s'il est présent dans `inherited`. `:id` est l'id numérique du
profil ; un profil inexistant répond `direct: {}` (pas de 404), donc aucun droit.

**Émetteur du jeton** : le jeton doit être demandé à l'**adresse publique** de Keycloak (celle de `KEYCLOAK_URL`, la même
que le front), jamais au nom interne du conteneur : l'`iss` serait différent et le gateway répondrait 401. Il dure 5 min ;
la Régie le garde en cache et le renouvelle 30 s avant l'expiration.

**Sécurité** : si le gateway ne répond pas ou refuse, le compte client n'a **aucun droit** (refus par défaut). Les
salariés gardent le comportement actuel.

### 2.3 Profils à créer dans l'Admin Panel
Après déploiement : *Profils & Droits → `regie` → Rafraîchir* (nouvelles clés, schéma version 5), puis créer par
exemple :

| Profil | Droits `regie` conseillés |
|---|---|
| Client régie – chiffres | `app.access`, `lieux.view_own`, `ventes.view` et les pages de chiffres voulues |
| Client régie – complet | le précédent + ce qu'un gérant peut voir (photos, paiements…) |
| Client régie – événements | le précédent + la gestion des événements de ses lieux |
| Client régie – admin | le profil choisi + `pages.mon_entreprise.view`, `comptes_entreprise.manage` |

Ne jamais donner à un profil client : `lieux.view_any` (sans effet de toute façon pour un compte client),
`entreprises.manage`, `utilisateurs.manage`, ni les droits d'administration.

Noter les **ids** de ces profils : ils vont dans `REGIE_PROFILS_CLIENTS` (seuls ces profils peuvent être attribués à un
compte client, par Selfizee comme par un client admin).

---

## 3. Variables d'environnement (Coolify)

### API
| Variable | Valeur |
|---|---|
| `KEYCLOAK_REGIE_REALM` | `regie` |
| `KEYCLOAK_REGIE_ADMIN_CLIENT_ID` | `regie-api` |
| `KEYCLOAK_REGIE_ADMIN_CLIENT_SECRET` | secret du client `regie-api` |
| `KEYCLOAK_REGIE_FRONT_CLIENT_ID` | `regie-selfizee` (lien de l'invitation) |
| `KONITYS_DROITS_CLIENT_ID` | `regie-droits` |
| `KONITYS_DROITS_CLIENT_SECRET` | secret du client `regie-droits` |
| `REGIE_PROFILS_CLIENTS` | ids des profils clients, séparés par des virgules |
| `APP_URL` | déjà posée : URL du front (retour après l'invitation) |

### Front (build)
| Variable | Valeur |
|---|---|
| `NEXT_PUBLIC_KEYCLOAK_REGIE_REALM` | `regie` (vide : l'accueil envoie tout le monde vers la connexion salarié) |

---

## 4. Recette (DEV)
1. *Entreprises* → nouvelle entreprise, deux lieux.
2. Nouveau compte (profil « Client régie – admin »), e-mail d'invitation reçu, mot de passe choisi.
3. Page d'accueil → e-mail du client → connexion client : seuls les deux lieux, seules les pages du profil.
4. Avec ce compte, ouvrir une autre app Konitys : refus (pas de session `konitys`).
5. *Mon entreprise* → inviter un collègue limité à un lieu ; il ne voit que ce lieu.
6. Désactiver l'entreprise : plus aucun de ses comptes n'entre.
7. Mettre un mauvais `KONITYS_DROITS_CLIENT_SECRET` : le client n'a plus aucun droit ; les salariés ne sont pas touchés.
