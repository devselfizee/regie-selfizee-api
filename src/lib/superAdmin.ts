// Super admins de la Régie : les e-mails de ADMIN_EMAILS (séparés par des virgules, variable Coolify), seuls à pouvoir
// supprimer un lieu ou une borne (demande du 13/11). Tout admin Konitys a tous les droits de l'application : une liste
// d'e-mails est le seul moyen de réserver ce geste à quelques personnes. Écart voulu à docs/PERMISSIONS_APP_INTEGRATION.md
// (3.7), limité à la suppression. Variable vide ou absente : personne.

export function estSuperAdmin(email: string | null | undefined, valeur = process.env.ADMIN_EMAILS): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return false;
  return (valeur ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .includes(e);
}
