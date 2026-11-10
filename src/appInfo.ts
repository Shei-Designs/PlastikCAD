// The one place the app's name and its publisher live in the frontend.
import { version } from '../package.json';

export const APP_NAME = 'PlastikCAD';
/** Read from package.json, the one place the number is set by hand besides the two the native build reads (kept in step by a test). */
export const APP_VERSION: string = version;
/** Where the source code and license live, shown in the About box. */
export const APP_URL = 'https://github.com/Shei-Designs/PlastikCAD';
/** The brand the app is published under, and who makes it. */
export const PUBLISHER = 'Shei Designs';
export const PUBLISHER_URL = 'https://sheidesigns.com';
export const AUTHOR = 'Andrew O\'Shei';
export const AUTHOR_URL = 'https://andrewoshei.com';
/** Marker written into design files, and their extension. */
export const FILE_FORMAT = 'plastikcad';
/**
 * The version of the design file's format, which is not the app's: most
 * versions of the app leave it as it is. 2 dropped the saved versions a file
 * used to carry. 3 is read strictly: a build refuses a file that names
 * something it does not know (a kind of object, part, option or sensor, a
 * field of an object, of the robot or of the design itself) rather than
 * dropping it and saving the rest, and offers a copy without it instead (see
 * `STRICT_FROM` and `parseDocWithout` in model/file.ts). A build tells such a
 * file by what is in it, so adding any of those needs no new number. Raise it
 * only when the file itself is laid out in another way.
 */
export const FILE_VERSION = 3;
export const FILE_EXTENSION = 'plastikcad';
/** What the app was called before it was PlastikCAD: files from then still open. */
export const LEGACY_FORMAT = 'bashcad';
export const LEGACY_EXTENSION = 'bashcad';
/** Whether a file name ends in the design extension, current or old. */
export const isDesignName = (name: string): boolean => /\.(plastikcad|bashcad)$/i.test(name);
