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

  it('name every Rust crate the native side is built with, at the version it is built with', () => {
    const notices = read('../public/THIRD-PARTY-NOTICES-NATIVE.txt');
    // The crates the app names itself, on every platform, at the versions the lock file pins.
    const manifest = read('../src-tauri/Cargo.toml');
    const direct = new Set<string>();
    let listing = false;
    for (const line of manifest.split('\n')) {
      if (line.startsWith('[')) listing = /^\[(target\..+\.)?dependencies\]$/.test(line.trim());
      else if (listing) {
        const name = /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
        // Its own plugin is the app's own code.
        if (name && !/path\s*=/.test(line)) direct.add(name);
      }
    }
    expect(direct.size).toBeGreaterThan(5);
    const lock = read('../src-tauri/Cargo.lock');
    for (const name of direct) {
      const versions = [...lock.matchAll(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`, 'g'))].map((m) => m[1]);
      expect(versions.length, name).toBeGreaterThan(0);
      expect(versions.some((version) => notices.includes(`\n${name} ${version}  (`)), `run pnpm notices: ${name} ${versions.join(', ')} is missing`).toBe(true);
    }
    // And every crate listed is one the lock file has, at that version: nothing left over from an older build.
    const listed = [...notices.split('-'.repeat(72))[1].matchAll(/^(\S+) (\S+) {2}\(/gm)];
    expect(listed.length).toBeGreaterThan(100);
    for (const [, name, version] of listed) expect(lock, `run pnpm notices: ${name} ${version} is no longer built in`).toContain(`name = "${name}"\nversion = "${version}"`);
  });
});
