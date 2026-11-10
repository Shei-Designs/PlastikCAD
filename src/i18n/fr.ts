// French. The texts are kept by the part of the app they come from; a text used in two parts is
// translated in both, the same way (a test sees to that). The words chosen for the app's own
// terms are listed in fr/glossary.md.
import type { Catalog } from './index';
import { app } from './fr/app';
import { editor } from './fr/editor';
import { io } from './fr/io';
import { partsDrive } from './fr/partsDrive';
import { partsFit } from './fr/partsFit';
import { robot } from './fr/robot';
import { state } from './fr/state';

/** The parts, for the test that looks for a text translated two ways. */
export const FR_PARTS: readonly Catalog[] = [app, editor, state, partsDrive, partsFit, robot, io];

export const fr: Catalog = Object.assign({}, ...FR_PARTS) as Catalog;
