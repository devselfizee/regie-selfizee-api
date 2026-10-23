// Limite de fréquence en mémoire (fenêtre glissante), pour les routes publiques.
// Une seule instance de l'API tourne : la mémoire du processus suffit.

export class Limiteur {
  private essais = new Map<string, number[]>();

  constructor(private max: number, private fenetreMs: number) {}

  /** Compte un essai pour cette clé ; faux si la limite est déjà atteinte (l'essai n'est alors pas compté). */
  essayer(cle: string, maintenant = Date.now()): boolean {
    const depuis = maintenant - this.fenetreMs;
    const recents = (this.essais.get(cle) ?? []).filter((t) => t > depuis);
    if (recents.length >= this.max) {
      this.essais.set(cle, recents);
      return false;
    }
    recents.push(maintenant);
    this.essais.set(cle, recents);
    // Ménage de temps en temps : les clés sans essai récent disparaissent
    if (this.essais.size > 10_000) for (const [k, v] of this.essais) if (!v.some((t) => t > depuis)) this.essais.delete(k);
    return true;
  }
}
