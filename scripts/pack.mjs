#!/usr/bin/env node
// Packs the package as it is published: the files npm would pack from this
// repository, with package.json and npm-shrinkwrap.json cut down to what the
// plugin needs at run time. Claude Code installs a plugin's packages from the
// lockfile beside its package.json, devDependencies included, so a full
// lockfile would install the compiler and the type packages for every user.
//
// Usage: node scripts/pack.mjs <destination folder> [--json]
// Prints the tarball's path, or with --json npm's record of the pack with the
// path added. Run `npm run build` first.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';

// The package.json users get: no devDependencies, and no scripts, since the
// build and test scripts name files the package does not hold.
export function runtimePackage(pkg) {
  const { devDependencies, scripts, ...rest } = pkg;
  return rest;
}

// The lockfile users get: the root entry without devDependencies, and no
// package only a devDependency needs.
export function runtimeLock(lock) {
  const packages = {};
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') {
      const { devDependencies, ...root } = entry;
      packages[key] = root;
    } else if (!entry.dev) {
      packages[key] = entry;
    }
  }
  return { ...lock, packages };
}

// On Windows npm is a .cmd file, which needs a shell, and a shell joins the
// arguments unquoted. So no argument may hold a path: npm packs in the stage
// folder and the tarball is copied out.
function npm(args, cwd) {
  const r = spawnSync('npm', args, { cwd, encoding: 'utf8', shell });
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export function pack(dest) {
  mkdirSync(dest, { recursive: true });
  const listed = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], REPO))[0].files.map((f) => f.path);
  const stage = mkdtempSync(path.join(tmpdir(), 'stillhunter-pack-'));
  try {
    for (const file of listed) {
      mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
      cpSync(path.join(REPO, file), path.join(stage, file));
    }
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(REPO, 'npm-shrinkwrap.json'), 'utf8'));
    writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(runtimePackage(pkg), null, 2)}\n`);
    writeFileSync(path.join(stage, 'npm-shrinkwrap.json'), `${JSON.stringify(runtimeLock(lock), null, 2)}\n`);
    const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts'], stage))[0];
    const tarball = path.join(path.resolve(dest), packed.filename);
    copyFileSync(path.join(stage, packed.filename), tarball);
    return { ...packed, path: tarball };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('Usage: node scripts/pack.mjs <destination folder> [--json]');
    process.exit(64);
  }
  const packed = pack(process.argv[2]);
  console.log(process.argv.includes('--json') ? JSON.stringify(packed) : packed.path);
}
