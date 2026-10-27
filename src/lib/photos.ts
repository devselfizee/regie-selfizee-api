// Adresse de la photo d'une séance à partir de son identifiant PikCloud (photo_uuid / pikcloud_uuid).
// Modèle réglé par PHOTOS_URL_MODELE, avec {uuid} à remplacer, par exemple
// https://photos.exemple.fr/{uuid}/apercu.jpg. Sans modèle, pas de photo affichée.
export function urlPhoto(uuid: string | null | undefined): string | null {
  const modele = process.env.PHOTOS_URL_MODELE;
  if (!modele || !uuid) return null;
  return modele.split("{uuid}").join(encodeURIComponent(uuid));
}
