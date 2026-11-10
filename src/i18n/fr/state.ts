// French: the editor's state. Notices and questions about projects, the trash and earlier saves,
// imports and exports, custom parts, Google Drive sync, and what is said of a design file that
// cannot be read; the names given to new things.
import type { Catalog } from '../index';

export const state: Catalog = {
  // Updates of the desktop app (state/store/updating.ts)
  'Version {version} of {app} is available.': 'La version {version} de {app} est disponible.',
  'Update…': 'Mettre à jour…',
  'Update {app}': 'Mettre à jour {app}',
  'Version {version} is available; this is version {current}.': 'La version {version} est disponible\u00a0; celle-ci est la version {current}.',
  'Open the releases page': 'Ouvrir la page des versions',
  'This copy of {app} was installed as a system package, which the app cannot update itself: the new version is on the releases page.':
    'Cet exemplaire de {app} a été installé comme paquet système, que l’application ne peut pas mettre à jour elle-même\u00a0: la nouvelle version se trouve sur la page des versions.',
  Later: 'Plus tard',
  Update: 'Mettre à jour',
  'The design is saved, the update installed, and {app} started again.': 'La conception est enregistrée, la mise à jour installée, puis {app} redémarre.',
  'Downloading the update…': 'Téléchargement de la mise à jour…',
  'Downloading the update… {percent}%': 'Téléchargement de la mise à jour… {percent}\u00a0%',
  'The update could not be installed: {reason}': 'La mise à jour n’a pas pu être installée\u00a0: {reason}',

  // A project a newer version of the app saved, and the copy this one can open of it (state/store/project.ts)
  'Made with a newer version': 'Créé avec une version plus récente',
  '"{name}" was saved by a newer version of {app}. Update the app to open it as it is.': '«\u00a0{name}\u00a0» a été enregistré par une version plus récente de {app}. Mettez l’application à jour pour l’ouvrir tel quel.',
  'This version can open a copy of it without {n} things it does not know. The project itself stays as it is.': {
    one: 'Cette version peut en ouvrir une copie, sans {n} élément qu’elle ne connaît pas. Le projet lui-même reste inchangé.',
    other: 'Cette version peut en ouvrir une copie, sans {n} éléments qu’elle ne connaît pas. Le projet lui-même reste inchangé.',
  },
  'This version can open a copy of it. The project itself stays as it is.': 'Cette version peut en ouvrir une copie. Le projet lui-même reste inchangé.',
  'Open a copy': 'Ouvrir une copie',
  'Opened "{name}".': '«\u00a0{name}\u00a0» ouvert.',

  // The name of a new design (model/file.ts, state/projects.ts)
  Untitled: 'Sans titre',

  // The open project and the others (state/store/project.ts)
  '{app} design': 'Conception {app}',
  'Could not save: {message}': 'Enregistrement impossible\u00a0: {message}',
  Saved: 'Enregistré',
  'Nothing to save yet': 'Rien à enregistrer pour l’instant',
  'The latest changes to "{name}" could not be saved. Leave anyway and lose them?': 'Les dernières modifications de «\u00a0{name}\u00a0» n’ont pas pu être enregistrées. Quitter quand même et les perdre\u00a0?',
  'Leave anyway': 'Quitter quand même',
  'Keep editing': 'Continuer à modifier',
  'New project': 'Nouveau projet',
  Name: 'Nom',
  Create: 'Créer',
  "\"{name}\" is now a project of its own in {app}. Changes you make are saved with the app's projects, not in the file you opened.":
    '«\u00a0{name}\u00a0» est désormais un projet à part entière dans {app}. Vos modifications sont enregistrées avec les projets de l’application, et non dans le fichier que vous avez ouvert.',
  'Project added': 'Projet ajouté',
  OK: 'OK',
  'Keep the file': 'Conserver le fichier',
  'Delete the file': 'Supprimer le fichier',
  'The file can stay where it is, or go.': 'Le fichier peut rester où il est, ou être supprimé.',
  'Deleted {name}.': '{name} supprimé.',
  '{app} could not delete {name} from here ({reason}). Remove it in your file manager.': '{app} n’a pas pu supprimer {name} d’ici ({reason}). Supprimez-le dans votre gestionnaire de fichiers.',
  '"{name}" carries {n} saved versions from an older version of the app, which no longer keeps them. Add each as a project of its own?': {
    one: '«\u00a0{name}\u00a0» contient {n} version enregistrée par une ancienne version de l’application, qui ne les conserve plus. L’ajouter comme projet à part entière\u00a0?',
    other: '«\u00a0{name}\u00a0» contient {n} versions enregistrées par une ancienne version de l’application, qui ne les conserve plus. Ajouter chacune comme projet à part entière\u00a0?',
  },
  'Add them': 'Les ajouter',
  'Drop them': 'Les abandonner',
  'Added {n} saved versions as projects.': { one: '{n} version enregistrée ajoutée comme projet.', other: '{n} versions enregistrées ajoutées comme projets.' },
  'your downloads': 'vos téléchargements',
  'Move "{name}" to the Trash?': 'Mettre «\u00a0{name}\u00a0» à la corbeille\u00a0?',
  'Move to Trash': 'Mettre à la corbeille',
  Keep: 'Conserver',
  'Delete "{name}"? This cannot be undone.': 'Supprimer «\u00a0{name}\u00a0»\u00a0? Cette action est irréversible.',
  Delete: 'Supprimer',
  'Delete "{name}" for good? Its earlier saves go with it. This cannot be undone.': 'Supprimer définitivement «\u00a0{name}\u00a0»\u00a0? Ses versions antérieures disparaissent avec lui. Cette action est irréversible.',
  'Delete everything in the Trash for good? This cannot be undone.': 'Supprimer définitivement tout le contenu de la corbeille\u00a0? Cette action est irréversible.',
  '{name} copy': '{name} copie',
  'Move your {n} projects to the new folder? Otherwise they stay where they are and only new projects go there.': {
    one: 'Déplacer votre projet vers le nouveau dossier\u00a0? Sinon, il reste où il est et seuls les nouveaux projets y vont.',
    other: 'Déplacer vos {n} projets vers le nouveau dossier\u00a0? Sinon, ils restent où ils sont et seuls les nouveaux projets y vont.',
  },
  'Move them': 'Les déplacer',
  'Leave them': 'Les laisser',
  '"{name}" stays in the old folder with the others.': '«\u00a0{name}\u00a0» reste dans l’ancien dossier avec les autres.',

  // Where an export went (state/store/exporting.ts)
  '{names} and {last}': '{names} et {last}',
  'Saved {list} to {where}': { one: '{list} enregistré dans {where}', other: '{list} enregistrés dans {where}' },
  'Share…': 'Partager…',
  Exported: 'Exportation terminée',
  '{list} are in {where}.': { one: '{list} se trouve dans {where}.', other: '{list} se trouvent dans {where}.' },
  Done: 'Terminé',
  Export: 'Exporter',
  'File name': 'Nom du fichier',

  // Files brought into the design (state/store/importing.ts)
  '"{name}"': '«\u00a0{name}\u00a0»',
  '"{file}" names {list} for its colors and pictures. Pick them now, or import the shapes without?': {
    one: '«\u00a0{file}\u00a0» renvoie à {list} pour ses couleurs et ses images. Choisir ce fichier maintenant, ou importer les formes sans lui\u00a0?',
    other: '«\u00a0{file}\u00a0» renvoie à {list} pour ses couleurs et ses images. Choisir ces fichiers maintenant, ou importer les formes sans eux\u00a0?',
  },
  '"{file}" names {list} for its colors. Pick them now, or import the shapes without?': {
    one: '«\u00a0{file}\u00a0» renvoie à {list} pour ses couleurs. Choisir ce fichier maintenant, ou importer les formes sans lui\u00a0?',
    other: '«\u00a0{file}\u00a0» renvoie à {list} pour ses couleurs. Choisir ces fichiers maintenant, ou importer les formes sans eux\u00a0?',
  },
  Import: 'Importer',
  Pick: 'Choisir',
  Without: 'Sans',
  'Material libraries and pictures': 'Bibliothèques de matériaux et images',
  '{name}: {message}': '{name}\u00a0: {message}',
  '"{name}" is flat or empty, so it cannot be made into a solid.': '«\u00a0{name}\u00a0» est plat ou vide et ne peut donc pas devenir un solide.',
  Pictures: 'Images',
  'A .mtl file holds the colors of an OBJ and is read with it: pick the .obj, together with the .mtl for its colors.':
    'Un fichier .mtl contient les couleurs d’un OBJ et se lit avec lui\u00a0: choisissez le .obj, accompagné du .mtl pour ses couleurs.',
  'Cannot import that. Supported: {formats}.': 'Importation impossible. Formats pris en charge\u00a0: {formats}.',
  'Importing…': 'Importation…',
  'URDF robot': 'Robot URDF',
  '"{file}" draws its links with {list}, which did not come along. Pick them now, or import without?': {
    one: '«\u00a0{file}\u00a0» dessine ses segments avec {list}, qui n’a pas été fourni. Le choisir maintenant, ou importer sans\u00a0?',
    other: '«\u00a0{file}\u00a0» dessine ses segments avec {list}, qui n’ont pas été fournis. Les choisir maintenant, ou importer sans\u00a0?',
  },
  Meshes: 'Maillages',
  'Imported {links} and {joints} from {file}.': '{links} et {joints} importés depuis {file}.',
  '{n} links': { one: '{n} segment', other: '{n} segments' },
  '{n} joints': { one: '{n} articulation', other: '{n} articulations' },
  'Models, drawings and pictures': 'Modèles, dessins et images',

  // Cloud sync as the editor sees it (state/store/sync.ts)
  'The open project was deleted on another device.': 'Le projet ouvert a été supprimé sur un autre appareil.',
  '"{name}" was changed on two devices at once; both versions were kept.': '«\u00a0{name}\u00a0» a été modifié sur deux appareils à la fois\u00a0; les deux versions ont été conservées.',
  'Deleted on another device: {names}.': 'Suppression sur un autre appareil\u00a0: {names}.',
  'Moved to the {folder} folder.': 'À retrouver dans le dossier {folder}.',
  'Synced "{name}" from Google Drive.': '«\u00a0{name}\u00a0» synchronisé depuis Google Drive.',
  'Synced {n} projects from Google Drive.': { one: '{n} projet synchronisé depuis Google Drive.', other: '{n} projets synchronisés depuis Google Drive.' },
  '{names} and {n} more': { one: '{names} et {n} autre', other: '{names} et {n} autres' },
  'The part "{name}" was changed on two devices at once; both versions were kept.': 'La pièce «\u00a0{name}\u00a0» a été modifiée sur deux appareils à la fois\u00a0; les deux versions ont été conservées.',
  'Parts deleted on another device: {names}.': 'Pièces supprimées sur un autre appareil\u00a0: {names}.',
  'Google Drive no longer has all {total} of your projects: {names}. Delete them from this device too?': 'Google Drive n’a plus aucun de vos {total} projets\u00a0: {names}. Les supprimer aussi de cet appareil\u00a0?',
  'Google Drive no longer has {count} of your {total} projects: {names}. Delete them from this device too?': 'Google Drive n’a plus {count} de vos {total} projets\u00a0: {names}. Les supprimer aussi de cet appareil\u00a0?',
  'Google Drive no longer has all {total} of your parts: {names}. Delete them from this device too?': 'Google Drive n’a plus aucune de vos {total} pièces\u00a0: {names}. Les supprimer aussi de cet appareil\u00a0?',
  'Google Drive no longer has {count} of your {total} parts: {names}. Delete them from this device too?': 'Google Drive n’a plus {count} de vos {total} pièces\u00a0: {names}. Les supprimer aussi de cet appareil\u00a0?',
  'This device no longer has all {total} of your projects in Google Drive: {names}. Delete them from Google Drive too?':
    'Cet appareil n’a plus aucun de vos {total} projets présents dans Google Drive\u00a0: {names}. Les supprimer aussi de Google Drive\u00a0?',
  'This device no longer has {count} of your {total} projects in Google Drive: {names}. Delete them from Google Drive too?':
    'Cet appareil n’a plus {count} de vos {total} projets présents dans Google Drive\u00a0: {names}. Les supprimer aussi de Google Drive\u00a0?',
  'This device no longer has all {total} of your parts in Google Drive: {names}. Delete them from Google Drive too?':
    'Cet appareil n’a plus aucune de vos {total} pièces présentes dans Google Drive\u00a0: {names}. Les supprimer aussi de Google Drive\u00a0?',
  'This device no longer has {count} of your {total} parts in Google Drive: {names}. Delete them from Google Drive too?':
    'Cet appareil n’a plus {count} de vos {total} pièces présentes dans Google Drive\u00a0: {names}. Les supprimer aussi de Google Drive\u00a0?',
  'Google Drive sync': 'Synchronisation Google Drive',
  'Delete them': 'Les supprimer',
  'Keep them': 'Les conserver',
  '{name} (other device)': '{name} (autre appareil)',
  '{app} will keep a copy of your projects in a "{app}" folder in your Google Drive and keep them in step with your other devices. It can see only the files it put there itself: a project file dropped into that folder by hand will not show up here. Sign in with Google now?':
    '{app} conservera une copie de vos projets dans un dossier «\u00a0{app}\u00a0» de votre Google Drive et les maintiendra à jour sur vos autres appareils. L’application ne voit que les fichiers qu’elle y a placés elle-même\u00a0: un fichier de projet déposé à la main dans ce dossier n’apparaîtra pas ici. Se connecter avec Google maintenant\u00a0?',
  'Link Google Drive': 'Associer Google Drive',
  'Sign in': 'Se connecter',
  'Not now': 'Pas maintenant',
  'Google Drive linked.': 'Google Drive associé.',
  'Unlink Google Drive? Your projects stay here and in your Drive, but changes no longer sync.': 'Dissocier Google Drive\u00a0? Vos projets restent ici et dans votre Drive, mais les modifications ne sont plus synchronisées.',
  Unlink: 'Dissocier',
  'Keep linked': 'Rester associé',
  'Google Drive unlinked.': 'Google Drive dissocié.',

  // Grouping, and editing inside a group (state/store/groups.ts)
  'Unlock the selected objects before grouping them.': 'Déverrouillez les objets sélectionnés avant de les grouper.',
  'Grouping…': 'Groupement…',
  Group: 'Groupe',
  'Nothing would be left: the holes remove everything.': 'Il ne resterait rien\u00a0: les perçages enlèvent tout.',
  'Unlock the object before editing inside it.': 'Déverrouillez l’objet avant de modifier son contenu.',
  'Regrouping…': 'Regroupement…',
  '"{name}" could not be put back together: nothing solid is left in it.': '«\u00a0{name}\u00a0» n’a pas pu être regroupé\u00a0: il n’y reste rien de solide.',

  // The custom parts bin (state/store/customParts.ts)
  'Save part': 'Enregistrer la pièce',
  'Save as a part': 'Enregistrer comme pièce',
  'Save "{name}" as a custom part? It goes in the library under Custom, on all your devices, to place in any design.':
    'Enregistrer «\u00a0{name}\u00a0» comme pièce personnalisée\u00a0? Elle rejoint la bibliothèque, sous «\u00a0Mes pièces\u00a0», sur tous vos appareils, pour être placée dans n’importe quelle conception.',
  Cancel: 'Annuler',
  '"{name}" is in your custom parts.': '«\u00a0{name}\u00a0» fait partie de vos pièces personnalisées.',
  'This part is empty.': 'Cette pièce est vide.',
  'Delete the part "{name}"? Objects already placed from it stay in their designs.': 'Supprimer la pièce «\u00a0{name}\u00a0»\u00a0? Les objets déjà placés à partir d’elle restent dans leurs conceptions.',

  // New lettering (state/store/placing.ts)
  Text: 'Texte',

  // Parametric parts (state/store/parts.ts)
  '"{name}" came out empty with these settings.': '«\u00a0{name}\u00a0» est vide avec ces paramètres.',
  'Making the part…': 'Création de la pièce…',

  // Align and array modes (state/store/tools.ts)
  'Select two or more objects to line them up.': 'Sélectionnez au moins deux objets pour les aligner.',
  'A pattern can have up to {limit} places.': 'Un réseau peut compter jusqu’à {limit} emplacements.',

  // The GLB export (state/glbExport.ts)
  'There is nothing to export.': 'Il n’y a rien à exporter.',

  // Where projects are kept (state/projects.ts)
  'This project is gone.': 'Ce projet n’existe plus.',
  'The project storage is in use by another tab.': 'Le stockage des projets est utilisé par un autre onglet.',
  'The project could not be stored.': 'Le projet n’a pas pu être enregistré.',
  'The project storage is not ready yet.': 'Le stockage des projets n’est pas encore prêt.',
  'The parts storage is not ready yet.': 'Le stockage des pièces n’est pas encore prêt.',

  // The sync schedule (sync/sync.ts)
  'Google Drive sync is not set up in this build.': 'La synchronisation Google Drive n’est pas configurée dans cette version.',
  'Google Drive sync stopped: {reason}': 'Synchronisation Google Drive interrompue\u00a0: {reason}',

  // Signing in to Google (sync/google.ts)
  'Sign in to Google Drive again.': 'Reconnectez-vous à Google Drive.',
  'Google answered {status}': 'Google a répondu {status}',
  'The sign-in was cancelled.': 'La connexion a été annulée.',
  'Google refused the sign-in: {error}': 'Google a refusé la connexion\u00a0: {error}',
  'The sign-in did not come back as expected. Try again.': 'La connexion ne s’est pas terminée comme prévu. Réessayez.',
  'Google gave no lasting access. Try signing in again.': 'Google n’a pas accordé d’accès durable. Essayez de vous reconnecter.',

  // What this device remembers of a sync (sync/state.ts)
  'The sync state could not be stored.': 'L’état de la synchronisation n’a pas pu être enregistré.',

  // The sync engine (sync/engine.ts)
  '"{name}": {message}': '«\u00a0{name}\u00a0»\u00a0: {message}',

  // Google Drive (sync/drive.ts)
  'Google Drive could not find its folder: {message}': 'Google Drive n’a pas pu trouver son dossier\u00a0: {message}',
  'Google Drive could not make its folder: {message}': 'Google Drive n’a pas pu créer son dossier\u00a0: {message}',
  'Google Drive could not list the projects: {message}': 'Google Drive n’a pas pu lister les projets\u00a0: {message}',
  'Google Drive could not download {name}: {message}': 'Google Drive n’a pas pu télécharger {name}\u00a0: {message}',
  'Google Drive could not upload {name}: {message}': 'Google Drive n’a pas pu envoyer {name}\u00a0: {message}',
  'Google Drive could not look at {name}: {message}': 'Google Drive n’a pas pu consulter {name}\u00a0: {message}',
  'Google Drive could not delete {name}: {message}': 'Google Drive n’a pas pu supprimer {name}\u00a0: {message}',
  'Google Drive could not read the account: {message}': 'Google Drive n’a pas pu lire le compte\u00a0: {message}',

  // Reading a design file (model/file.ts)
  'This design was saved by a newer version of the app. Update to open it.': 'Cette conception a été enregistrée par une version plus récente de l’application. Mettez l’application à jour pour l’ouvrir.',
  'This design is nested too deeply.': 'Cette conception est imbriquée trop profondément.',
  Object: 'Objet',
  Outer: 'Extérieur',
  Bore: 'Alésage',
  Picture: 'Image',
  'This file is not a design: it could not be read as JSON.': 'Ce fichier n’est pas une conception\u00a0: il n’a pas pu être lu comme du JSON.',
  'This file is not a design made with this app.': 'Ce fichier n’est pas une conception créée avec cette application.',
  'This file is not a design made with this app: it does not say which version of the format it is in.': 'Ce fichier n’est pas une conception créée avec cette application\u00a0: il n’indique pas la version de son format.',
  'Version {n}': 'Version {n}',

  // The fonts of lettering (model/types.ts)
  Sans: 'Sans empattement',
  'Slab serif': 'Empattement carré',
  Monospace: 'Largeur fixe',
  Stencil: 'Pochoir',
};
