// Numéros de téléphone saisis à la main (contacts d'un lieu) : enregistrés au format international E.164
// (« +33669045935 »), quelle que soit la saisie (« 06 69 04 59 35 », « +33 6 69… », « 0033 6… », « +33 (0)6… »). Un numéro
// sans indicatif est français ; un numéro étranger se saisit avec son indicatif (« +971 50 123 4567 »).

/** Le numéro en E.164 ; null s'il est vide ; undefined s'il n'est pas un numéro possible. */
export function telephoneE164(brut: string | null | undefined): string | null | undefined {
  const t = (brut ?? "").trim();
  if (!t) return null;
  if (/[^\d\s+().\-/]/.test(t)) return undefined; // lettres, extension…
  // « +33 (0)6… » : le 0 entre parenthèses n'est pas composé depuis l'étranger
  let n = t.replace(/\(0\)/g, "").replace(/[\s().\-/]/g, "");
  if (n.startsWith("00")) n = `+${n.slice(2)}`;
  if (n.indexOf("+", 1) !== -1) return undefined;
  if (n.startsWith("+")) {
    if (n.startsWith("+330")) n = `+33${n.slice(4)}`; // « +33 06… » : le 0 de trop
  } else if (/^0[1-9]\d{8}$/.test(n)) n = `+33${n.slice(1)}`;
  else if (/^[1-9]\d{8}$/.test(n)) n = `+33${n}`; // français saisi sans le 0
  else return undefined;
  if (n.startsWith("+33") && !/^\+33[1-9]\d{8}$/.test(n)) return undefined;
  return /^\+[1-9]\d{6,14}$/.test(n) ? n : undefined;
}
