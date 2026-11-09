// Texte riche des fiches (gras, italique, souligné, listes, retours à la ligne) : saisi dans un éditeur
// contentEditable, enregistré en HTML. Seules ces balises sont gardées, sans aucun attribut : rien d'exécutable.
const AUTORISEES = new Set(["b", "strong", "i", "em", "u", "br", "p", "div", "ul", "ol", "li"]);

export function nettoyerTexteRiche(html: string | null | undefined): string | null {
  if (html == null) return null;
  let t = String(html)
    // Contenu des balises dangereuses retiré avec elles
    .replace(/<(script|style|iframe|object|embed|template|noscript)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // Balises : gardées sans attribut si autorisées, retirées sinon (répété : balises imbriquées)
  for (let avant = ""; avant !== t; ) {
    avant = t;
    t = t.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)[^>]*>/g, (_m, ferme: string, nom: string) => {
      const n = nom.toLowerCase();
      return AUTORISEES.has(n) ? (n === "br" ? "<br>" : `<${ferme}${n}>`) : "";
    });
  }
  // Chevrons restants (texte) neutralisés
  t = t.replace(/<(?!\/?(b|strong|i|em|u|br|p|div|ul|ol|li)>)/gi, "&lt;");
  const vide = t.replace(/<[^>]*>|&nbsp;|\s/g, "") === "";
  return vide ? null : t.slice(0, 20_000);
}
