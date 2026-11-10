// What has to agree with package.json: the version number, written in three
// files (the release is tagged from one of them), and the notices of the
// libraries the app ships.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './appInfo';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the app version', () => {
  it('is the same in package.json, the Tauri configuration and the Rust crate', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.parse(read('../src-tauri/tauri.conf.json')).version).toBe(APP_VERSION);
    expect(/^version = "(.+)"$/m.exec(read('../src-tauri/Cargo.toml'))?.[1]).toBe(APP_VERSION);
  });
});

describe('the third-party notices', () => {
  it('name every library the app ships, and every font has its license beside them', () => {
    const libraries = Object.keys(JSON.parse(read('../package.json')).dependencies as Record<string, string>);
    const notices = read('../public/THIRD-PARTY-NOTICES.txt');
    for (const name of libraries.filter((n) => !n.startsWith('@fontsource/'))) expect(notices, `run pnpm notices: ${name} is missing`).toContain(`\n${name}\nLicense: `);
    const fonts = readdirSync(new URL('../public/font-licenses/', import.meta.url)).map((f) => f.toLowerCase().replace('.txt', ''));
    for (const name of libraries.filter((n) => n.startsWith('@fontsource/'))) expect(fonts, name).toContain(name.slice('@fontsource/'.length));
  });
});
