// French: importing and exporting files. The export formats the format picker lists, what the
// readers of STL, OBJ, PLY, 3MF, glTF, Collada, DXF, SVG and URDF files say of a file they cannot
// read, and what the URDF reader says of what it left out. Nothing written into a file is here.
import type { Catalog } from '../index';

export const io: Catalog = {
  // The export formats (export.ts)
  'Binary mesh': 'Maillage binaire',
  'Mesh with colors and units': 'Maillage avec couleurs et unités',
  'Text mesh with colors': 'Maillage texte avec couleurs',
  'Binary mesh with a color on every face': 'Maillage binaire avec une couleur par face',
  'Mesh with pictures': 'Maillage avec images',
  'Solids with true surfaces': 'Solides à surfaces exactes',
  'Top-down outline as vector graphics': 'Contour vu de dessus, en dessin vectoriel',
  'Top-down outline as a drawing': 'Contour vu de dessus, en plan',

  // Reading a file of any kind (import.ts)
  'Import [[object name]]': 'Importation',
  ".{extension} files can't be imported. Use one of: {supported}.": 'Les fichiers .{extension} ne peuvent pas être importés. Formats acceptés\u00a0: {supported}.',
  "Files of this type can't be imported. Use one of: {supported}.": 'Les fichiers de ce type ne peuvent pas être importés. Formats acceptés\u00a0: {supported}.',
  'This {format} file is damaged or not supported.': 'Ce fichier {format} est endommagé ou non pris en charge.',
  'This file holds coordinates that are not numbers, and cannot be imported.': 'Ce fichier contient des coordonnées qui ne sont pas des nombres et ne peut pas être importé.',
  'This file is damaged: its triangles point at corners it does not have.': 'Ce fichier est endommagé\u00a0: ses triangles renvoient à des sommets qu’il n’a pas.',

  // A file read in the geometry worker (worker/importing.ts)
  'The file is no longer at hand. Import it again.': 'Le fichier n’est plus disponible. Importez-le de nouveau.',

  // Draco (importGlb.ts, worker/importing.ts)
  'This glTF file is damaged: a compressed mesh cannot be unpacked.': 'Ce fichier glTF est endommagé\u00a0: un maillage compressé ne peut pas être décompressé.',
  'The decoder for this compressed glTF file could not be loaded.': 'Le décodeur de ce fichier glTF compressé n’a pas pu être chargé.',

  // STEP (importStep.ts)
  'A STEP file cannot be read as part of another file.': 'Un fichier STEP ne peut pas être lu comme partie d’un autre fichier.',
  'This STEP file is empty.': 'Ce fichier STEP est vide.',
  'This STEP file has no shapes.': 'Ce fichier STEP ne contient aucune forme.',
  'This STEP file is too detailed to open.': 'Ce fichier STEP est trop détaillé pour être ouvert.',
  'STEP files cannot be read here.': 'Les fichiers STEP ne peuvent pas être lus ici.',
  'The STEP reader could not be loaded.': 'Le lecteur STEP n’a pas pu être chargé.',

  // STEP out (stepExport.ts, worker/serve.ts)
  'STEP files cannot be written here.': 'Les fichiers STEP ne peuvent pas être écrits ici.',
  'The STEP writer could not be loaded.': 'Le module d’écriture STEP n’a pas pu être chargé.',
  'Too detailed for a STEP file: {names}.': 'Trop détaillé pour un fichier STEP\u00a0: {names}.',
  'Too detailed to export as STEP': 'Trop détaillé pour un export STEP',
  '"{name}" could not be written to the STEP file and was left out.': '«\u00a0{name}\u00a0» n’a pas pu être écrit dans le fichier STEP et a été ignoré.',
  '"{name}" is not watertight and was exported as a surface.': '«\u00a0{name}\u00a0» n’est pas étanche et a été exporté comme surface.',
  'The STEP file could not be written.': 'Le fichier STEP n’a pas pu être écrit.',
  '"{name}" may not be whole in the STEP file: check it where it is opened.': '«\u00a0{name}\u00a0» n’est peut-être pas complet dans le fichier STEP\u00a0: vérifiez-le là où il est ouvert.',

  // XML (xml.ts)
  'This file is nested too deeply to read.': 'Ce fichier est imbriqué trop profondément pour être lu.',

  // STL (importStl.ts)
  'This STL file is empty.': 'Ce fichier STL est vide.',
  'This is not an STL file, or it is incomplete.': 'Ce n’est pas un fichier STL, ou il est incomplet.',
  'This STL file is incomplete: it should hold {count} triangles but ends after {present}.': 'Ce fichier STL est incomplet\u00a0: il devrait contenir {count} triangles mais s’arrête après {present}.',
  'This STL file has no triangles.': 'Ce fichier STL n’a aucun triangle.',

  // OBJ (importObj.ts)
  'This OBJ file is empty.': 'Ce fichier OBJ est vide.',
  'This OBJ file has no usable faces.': 'Ce fichier OBJ n’a aucune face utilisable.',
  'This OBJ file has no faces.': 'Ce fichier OBJ n’a aucune face.',

  // PLY (importPly.ts)
  'This PLY file is empty.': 'Ce fichier PLY est vide.',
  'This is not a PLY file.': 'Ce n’est pas un fichier PLY.',
  'This PLY file is damaged: its header has no end.': 'Ce fichier PLY est endommagé\u00a0: son en-tête n’a pas de fin.',
  'This PLY file is damaged: its header cannot be read.': 'Ce fichier PLY est endommagé\u00a0: son en-tête ne peut pas être lu.',
  'This PLY file is damaged: a list has no length.': 'Ce fichier PLY est endommagé\u00a0: une liste n’a pas de longueur.',
  'This PLY file is incomplete: it ends before its last point or face.': 'Ce fichier PLY est incomplet\u00a0: il s’arrête avant son dernier point ou sa dernière face.',
  'This PLY file has no points.': 'Ce fichier PLY n’a aucun point.',
  'This PLY file holds points with no faces between them, which cannot be made into a solid.': 'Ce fichier PLY contient des points sans faces entre eux, dont on ne peut pas faire un solide.',
  'This PLY file has no usable faces.': 'Ce fichier PLY n’a aucune face utilisable.',

  // Zip archives (zip.ts)
  'This zip file is too large to open.': 'Ce fichier zip est trop volumineux pour être ouvert.',

  // 3MF (import3mf.ts)
  'This 3MF file is too large to open.': 'Ce fichier 3MF est trop volumineux pour être ouvert.',
  'This 3MF file is empty.': 'Ce fichier 3MF est vide.',
  'This 3MF file is damaged, or is not a 3MF file.': 'Ce fichier 3MF est endommagé, ou n’est pas un fichier 3MF.',
  'This 3MF file has no 3D model in it.': 'Ce fichier 3MF ne contient aucun modèle 3D.',
  'This 3MF file has too many components to open.': 'Ce fichier 3MF a trop de composants pour être ouvert.',
  'This 3MF file has too many triangles to open.': 'Ce fichier 3MF a trop de triangles pour être ouvert.',
  'This 3MF file has no meshes.': 'Ce fichier 3MF n’a aucun maillage.',

  // glTF and GLB (importGlb.ts)
  'This is not a glTF file.': 'Ce n’est pas un fichier glTF.',
  'This is not a glTF file: it could not be read as JSON.': 'Ce n’est pas un fichier glTF\u00a0: il n’a pas pu être lu comme du JSON.',
  'Only glTF version 2 files can be imported.': 'Seuls les fichiers glTF version 2 peuvent être importés.',
  'This glTF file is empty.': 'Ce fichier glTF est vide.',
  'This glTF file is compressed. Export it again without mesh compression and import that.': 'Ce fichier glTF est compressé. Exportez-le à nouveau sans compression de maillage et importez ce fichier.',
  'This glTF file keeps its data in separate files. Save it as a single .glb and import that.': 'Ce fichier glTF garde ses données dans des fichiers séparés. Enregistrez-le en un seul .glb et importez ce fichier.',
  'This glTF file keeps a mesh as a sparse accessor, which cannot be read. Export it again without sparse accessors.': 'Ce fichier glTF garde un maillage dans un accesseur creux, qui ne peut pas être lu. Exportez-le à nouveau sans accesseurs creux.',
  'This glTF file has too many triangles to open.': 'Ce fichier glTF a trop de triangles pour être ouvert.',
  'This glTF file has too many nodes to open.': 'Ce fichier glTF a trop de nœuds pour être ouvert.',
  'This glTF file has no meshes.': 'Ce fichier glTF n’a aucun maillage.',
  'This glTF file is damaged: its {key} are not a list.': 'Ce fichier glTF est endommagé\u00a0: ses {key} ne sont pas une liste.',
  'This glTF file is damaged: its list of extensions is not one.': 'Ce fichier glTF est endommagé\u00a0: sa liste d’extensions n’en est pas une.',
  'This glTF file is damaged: its scene is not a number.': 'Ce fichier glTF est endommagé\u00a0: sa scène n’est pas un nombre.',
  'This glTF file is damaged: a scene does not list its nodes.': 'Ce fichier glTF est endommagé\u00a0: une scène ne donne pas la liste de ses nœuds.',
  'This glTF file is damaged: a node is not as it should be.': 'Ce fichier glTF est endommagé\u00a0: un nœud n’est pas conforme.',
  'This glTF file is damaged: a node is placed by something other than numbers.': 'Ce fichier glTF est endommagé\u00a0: un nœud est placé par autre chose que des nombres.',
  'This glTF file is damaged: a mesh has no primitives.': 'Ce fichier glTF est endommagé\u00a0: un maillage n’a aucune primitive.',
  'This glTF file is damaged: a primitive has no attributes.': 'Ce fichier glTF est endommagé\u00a0: une primitive n’a aucun attribut.',
  'This glTF file is damaged: a primitive is not as it should be.': 'Ce fichier glTF est endommagé\u00a0: une primitive n’est pas conforme.',
  'This glTF file is damaged: a material is not as it should be.': 'Ce fichier glTF est endommagé\u00a0: un matériau n’est pas conforme.',
  'This glTF file is damaged: a material has a color that is not numbers.': 'Ce fichier glTF est endommagé\u00a0: un matériau a une couleur qui n’est pas faite de nombres.',
  'This glTF file is damaged: a material names its texture wrongly.': 'Ce fichier glTF est endommagé\u00a0: un matériau désigne mal sa texture.',
  'This glTF file is damaged: a texture names its image wrongly.': 'Ce fichier glTF est endommagé\u00a0: une texture désigne mal son image.',
  'This glTF file is damaged: an image is not as it should be.': 'Ce fichier glTF est endommagé\u00a0: une image n’est pas conforme.',
  'This glTF file is damaged: an accessor is not as it should be.': 'Ce fichier glTF est endommagé\u00a0: un accesseur n’est pas conforme.',
  'This glTF file is damaged: an accessor has an unknown type.': 'Ce fichier glTF est endommagé\u00a0: un accesseur a un type inconnu.',
  'This glTF file is damaged: a buffer view is not as it should be.': 'Ce fichier glTF est endommagé\u00a0: une vue de tampon n’est pas conforme.',
  'This glTF file is damaged: a buffer is not as it should be.': 'Ce fichier glTF est endommagé\u00a0: un tampon n’est pas conforme.',
  'This glTF file is damaged: its embedded data cannot be read.': 'Ce fichier glTF est endommagé\u00a0: ses données intégrées ne peuvent pas être lues.',
  'This glTF file is damaged: a buffer is missing.': 'Ce fichier glTF est endommagé\u00a0: un tampon manque.',
  'This glTF file is damaged: a buffer view is missing.': 'Ce fichier glTF est endommagé\u00a0: une vue de tampon manque.',
  'This glTF file is damaged: a buffer view runs past its buffer.': 'Ce fichier glTF est endommagé\u00a0: une vue de tampon dépasse son tampon.',
  'This glTF file is damaged: an accessor has no data.': 'Ce fichier glTF est endommagé\u00a0: un accesseur n’a pas de données.',
  'This glTF file is damaged: an accessor runs past its buffer view.': 'Ce fichier glTF est endommagé\u00a0: un accesseur dépasse sa vue de tampon.',
  'This glTF file is damaged: an accessor has an unknown component type.': 'Ce fichier glTF est endommagé\u00a0: un accesseur a un type de composante inconnu.',
  'This glTF file is damaged: a chunk runs past the end of the file.': 'Ce fichier glTF est endommagé\u00a0: un bloc dépasse la fin du fichier.',
  'This glTF file is damaged: it has no JSON chunk.': 'Ce fichier glTF est endommagé\u00a0: il n’a pas de bloc JSON.',

  // Collada (importCollada.ts)
  'This Collada file is empty.': 'Ce fichier Collada est vide.',
  'This is not a Collada file.': 'Ce n’est pas un fichier Collada.',
  'This Collada file has too many triangles to open.': 'Ce fichier Collada a trop de triangles pour être ouvert.',
  'This Collada file has too many nodes to open.': 'Ce fichier Collada a trop de nœuds pour être ouvert.',
  'This Collada file has no meshes.': 'Ce fichier Collada n’a aucun maillage.',

  // DXF (importDxf.ts)
  'This DXF has too many entities to open.': 'Ce DXF a trop d’entités pour être ouvert.',
  'This is not a DXF file.': 'Ce n’est pas un fichier DXF.',
  'This DXF has too many points to open.': 'Ce DXF a trop de points pour être ouvert.',
  'This DXF has no closed outlines that can be extruded.': 'Ce DXF n’a aucun contour fermé qui puisse être extrudé.',
  '{n} outlines do not close and were left out.': { one: '{n} contour ne se ferme pas et a été ignoré.', other: '{n} contours ne se ferment pas et ont été ignorés.' },
  '{n} pieces of text were left out.': { one: '{n} texte a été ignoré.', other: '{n} textes ont été ignorés.' },
  'Binary DXF files cannot be imported. Save the drawing as ASCII DXF.': 'Les fichiers DXF binaires ne peuvent pas être importés. Enregistrez le dessin en DXF ASCII.',

  // SVG (importSvg.ts)
  'This is not an SVG file.': 'Ce n’est pas un fichier SVG.',
  'This SVG has no shapes that can be extruded.': 'Ce SVG n’a aucune forme qui puisse être extrudée.',
  '{n} copies of other shapes (<use>) were left out.': { one: '{n} copie d’une autre forme (<use>) a été ignorée.', other: '{n} copies d’autres formes (<use>) ont été ignorées.' },
  '{n} pieces of text were left out. Turn text into paths in the drawing program.': {
    one: '{n} texte a été ignoré. Convertissez le texte en tracés dans le logiciel de dessin.',
    other: '{n} textes ont été ignorés. Convertissez le texte en tracés dans le logiciel de dessin.',
  },
  '{n} pictures were left out.': { one: '{n} image a été ignorée.', other: '{n} images ont été ignorées.' },
  '{n} rules of its style sheet were not read: colors and hidden shapes set there are not applied.': {
    one: '{n} règle de sa feuille de style n’a pas été lue\u00a0: les couleurs et les formes masquées qui y sont définies ne sont pas appliquées.',
    other: '{n} règles de sa feuille de style n’ont pas été lues\u00a0: les couleurs et les formes masquées qui y sont définies ne sont pas appliquées.',
  },
  'This SVG has too many shapes to open.': 'Ce SVG contient trop de formes pour être ouvert.',
  'Its style sheet was not read: colors and hidden shapes set there are not applied.': 'Sa feuille de style n’a pas été lue\u00a0: les couleurs et les formes masquées qui y sont définies ne sont pas appliquées.',

  // URDF (importUrdf.ts)
  Robot: 'Robot',
  joint: 'articulation',
  '{name} joint': 'Articulation {name}',
  'This is not a URDF file: it does not hold a <robot>.': 'Ce n’est pas un fichier URDF\u00a0: il ne contient pas de <robot>.',
  'This is a xacro file. Run it through xacro first (xacro robot.urdf.xacro > robot.urdf) and import the URDF it writes.': 'C’est un fichier xacro. Passez-le d’abord par xacro (xacro robot.urdf.xacro > robot.urdf) et importez l’URDF obtenu.',
  'This URDF has no links.': 'Cet URDF n’a aucun segment.',
  'No link in this URDF has a shape that can be shown.': 'Aucun segment de cet URDF n’a de forme affichable.',
  '"{link}" is drawn with "{file}", which is not a file in the robot\'s package; it was left out.': '«\u00a0{link}\u00a0» est dessiné avec «\u00a0{file}\u00a0», qui n’est pas un fichier du paquet du robot\u00a0; ce fichier a été ignoré.',
  '"{link}" is drawn with "{file}", a kind of mesh file that cannot be read.': '«\u00a0{link}\u00a0» est dessiné avec «\u00a0{file}\u00a0», un type de fichier de maillage qui ne peut pas être lu.',
  '"{link}" is drawn with "{file}", which could not be read: {reason}': '«\u00a0{link}\u00a0» est dessiné avec «\u00a0{file}\u00a0», qui n’a pas pu être lu\u00a0: {reason}',
  '"{link}" is shown by its collision shape, as its visual could not be read.': '«\u00a0{link}\u00a0» est affiché par sa forme de collision, son visuel n’ayant pas pu être lu.',
  'Joint "{joint}" hangs "{child}" from "{parent}", which the file does not have; "{child}" stands on its own.': 'L’articulation «\u00a0{joint}\u00a0» attache «\u00a0{child}\u00a0» à «\u00a0{parent}\u00a0», que le fichier ne contient pas\u00a0; «\u00a0{child}\u00a0» reste indépendant.',
  '"{child}" hangs from two joints; "{joint}" was left out, as URDF allows one.': '«\u00a0{child}\u00a0» dépend de deux articulations\u00a0; «\u00a0{joint}\u00a0» a été ignorée, URDF n’en admettant qu’une.',
  '"{name}" hangs in a loop of joints and was left out.': '«\u00a0{name}\u00a0» fait partie d’une boucle d’articulations et a été ignoré.',
  '"{name}" moves but has no shape; a small box stands for it.': '«\u00a0{name}\u00a0» bouge mais n’a pas de forme\u00a0; une petite boîte le représente.',
  '"{name}" has mass but no shape; its mass was dropped.': '«\u00a0{name}\u00a0» a une masse mais pas de forme\u00a0; sa masse a été ignorée.',
  '"{name}" has a mesh that could not be read and was left out.': '«\u00a0{name}\u00a0» a un maillage qui n’a pas pu être lu et a été ignoré.',
  '"{name}" is flat or empty and was left out.': '«\u00a0{name}\u00a0» est plat ou vide et a été ignoré.',
  'Joint "{joint}" was dropped: nothing above "{link}" has a shape to hang it from. "{link}" is fixed to the base.': 'L’articulation «\u00a0{joint}\u00a0» a été supprimée\u00a0: rien au-dessus de «\u00a0{link}\u00a0» n’a de forme à laquelle l’attacher. «\u00a0{link}\u00a0» est fixé à la base.',
  '"{name}" was not attached to anything; it is fixed to the base where it stands.': '«\u00a0{name}\u00a0» n’était attaché à rien\u00a0; il est fixé à la base, là où il se trouve.',
  'Joint "{joint}" is floating, which the design cannot hold; it was made fixed.': 'L’articulation «\u00a0{joint}\u00a0» est flottante, ce que la conception ne permet pas\u00a0; elle a été rendue fixe.',
  'Joint "{joint}" is planar, which the design cannot hold; it was made fixed.': 'L’articulation «\u00a0{joint}\u00a0» est plane, ce que la conception ne permet pas\u00a0; elle a été rendue fixe.',
  'Joint "{joint}" is of type "{type}", which the design cannot hold; it was made fixed.': 'L’articulation «\u00a0{joint}\u00a0» est de type «\u00a0{type}\u00a0», ce que la conception ne permet pas\u00a0; elle a été rendue fixe.',
  'Joint "{joint}" follows "{leader}", which was not kept; it moves on its own.': 'L’articulation «\u00a0{joint}\u00a0» suit «\u00a0{leader}\u00a0», qui n’a pas été conservée\u00a0; elle bouge seule.',
  'Sensor "{sensor}" sits on "{link}", which has no shape to carry it; it was left out.': 'Le capteur «\u00a0{sensor}\u00a0» est placé sur «\u00a0{link}\u00a0», qui n’a pas de forme pour le porter\u00a0; il a été ignoré.',
  'Sensor "{name}" is a kind the design has no sensor for; it was left out.': 'Le capteur «\u00a0{name}\u00a0» est d’un type pour lequel la conception n’a pas de capteur\u00a0; il a été ignoré.',
  'Sensor "{name}" is a {type} the design has no sensor for; it was left out.': 'Le capteur «\u00a0{name}\u00a0» est de type {type}, pour lequel la conception n’a pas de capteur\u00a0; il a été ignoré.',
  'The drive names joint "{joint}", which was not kept.': 'L’entraînement désigne l’articulation «\u00a0{joint}\u00a0», qui n’a pas été conservée.',
};
