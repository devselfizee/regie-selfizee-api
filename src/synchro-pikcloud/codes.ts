// Codes de réponse du webhook de synchro PikCloud (contrat du 04/11/2026, § 5).
// Plage réservée à Régie : 4000 à 4999 (0-2999 PikCloud, 3000-3999 Kalifun). Les messages sont en
// français : ils s'affichent dans le back-office PikCloud (« Erreurs transfert »). Liste à transmettre
// à l'équipe PikCloud (docs/synchronisation-pikcloud.md).

export const CODES_SYNCHRO = {
  OK: { code: 200, message: "OK" },
  DEJA_RECU: { code: 200, message: "Fichier déjà reçu" },
  EN_ATTENTE: { code: 200, message: "Fichier enregistré, téléchargement en attente" },
  // Succès quand même (sinon 12 renvois pour rien) : le média est stocké sans événement et signalé dans la file d'erreurs
  EVENEMENT_INCONNU: { code: 4001, message: "Événement inconnu côté Régie" },
  TELECHARGEMENT_IMPOSSIBLE: { code: 4002, message: "Téléchargement du média impossible" },
  JSON_ILLISIBLE: { code: 4003, message: "JSON de séance illisible" },
  HOTE_INTERDIT: { code: 4004, message: "Lien hors des hôtes PikCloud autorisés" },
} as const;

export type CodeSynchro = keyof typeof CODES_SYNCHRO;

/** Une entrée de la réponse (`data` ou `photo`). */
export interface EntreeReponse {
  success: boolean;
  status: { code: number; message: string };
}

export const succes = (code: CodeSynchro = "OK"): EntreeReponse => ({ success: true, status: { ...CODES_SYNCHRO[code] } });
export const echec = (code: CodeSynchro, detail?: string): EntreeReponse => ({
  success: false,
  status: { code: CODES_SYNCHRO[code].code, message: detail ? `${CODES_SYNCHRO[code].message} : ${detail}` : CODES_SYNCHRO[code].message },
});
