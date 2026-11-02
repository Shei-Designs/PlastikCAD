// The one place the app's name and its publisher live in the frontend.
export const APP_NAME = 'PlastikCAD';
export const APP_VERSION = '0.1.0';
/** Where the source code and license live, shown in the About box. */
export const APP_URL = 'https://github.com/Shei-Designs/PlastikCAD';
/** The brand the app is published under, and who makes it. */
export const PUBLISHER = 'Shei Designs';
export const PUBLISHER_URL = 'https://sheidesigns.com';
export const AUTHOR = 'Andrew O\'Shei';
export const AUTHOR_URL = 'https://andrewoshei.com';
/** Marker written into design files, and their extension. */
export const FILE_FORMAT = 'plastikcad';
/** 2 dropped the saved versions a file used to carry. */
export const FILE_VERSION = 2;
export const FILE_EXTENSION = 'plastikcad';
/** What the app was called before it was PlastikCAD: files from then still open. */
export const LEGACY_FORMAT = 'bashcad';
export const LEGACY_EXTENSION = 'bashcad';
/** Whether a file name ends in the design extension, current or old. */
export const isDesignName = (name: string): boolean => /\.(plastikcad|bashcad)$/i.test(name);
