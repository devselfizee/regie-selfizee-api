// Département d'un lieu, déduit du code postal : 2 chiffres, 2A / 2B pour la Corse, 3 chiffres outre-mer.
export function departement(codePostal: string | null | undefined): string | null {
  const cp = (codePostal ?? "").replace(/\s/g, "");
  if (!/^\d{5}$/.test(cp)) return null;
  if (cp.startsWith("97") || cp.startsWith("98")) return cp.slice(0, 3);
  if (cp.startsWith("20")) return cp < "20200" ? "2A" : "2B";
  return cp.slice(0, 2);
}
