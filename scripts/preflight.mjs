#!/usr/bin/env node
/**
 * Release preflight for dsh-time-pin.
 *
 * Static checks that catch the mistakes `npm publish` would otherwise ship:
 * version/CHANGELOG agreement, required files, the packaged file list (the
 * marketplace screenshots must be in, raw captures/tests/temp files must be
 * out), and the presence of the features the README advertises.
 *
 * Usage: `npm run preflight` (runs on every CI push and before a release).
 * Exit code 0 when every check passes, 1 with a list of problems otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const fail = (message) => problems.push(message);

/** Read and parse one JSON file. */
function readJson(relativePath) {
  const path = join(root, relativePath);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${relativePath} is missing or not valid JSON (${error.message})`);
    return null;
  }
}

// --- 1. package.json -------------------------------------------------------
const pkg = readJson('package.json');
if (pkg !== null) {
  if (pkg.name !== 'dsh-time-pin') fail(`package.json name is ${pkg.name}, expected dsh-time-pin`);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? '')) fail(`package.json version is not semver: ${pkg.version}`);
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
    fail('package.json must declare dsh.bundle.patch: "./cordis.patch.yml" (installable module)');
  }
  if (pkg.dsh?.client === undefined) fail('package.json must declare dsh.client (Web title-bar control)');
  if (pkg.repository === undefined) fail('package.json must declare repository so the marketplace can map npm -> GitHub');
  if (pkg.engines?.dsh === undefined) notes.push('package.json engines.dsh is not set');
}

// --- 2. version / CHANGELOG agreement --------------------------------------
let changelogVersion = null;
try {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const match = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  changelogVersion = match?.[1] ?? null;
} catch {
  fail('CHANGELOG.md is missing');
}
if (changelogVersion !== null && pkg !== null && changelogVersion !== pkg.version) {
  fail(`CHANGELOG.md newest release is ${changelogVersion}, package.json is ${pkg.version}`);
}

// --- 3. required files ------------------------------------------------------
const required = [
  'README.md',
  'README.zh.md',
  'LICENSE',
  'icon.svg',
  'cordis.patch.yml',
  'screenshots.json',
  'lib/index.js',
  'lib/client.js',
  'lib/evidence.js',
  'lib/silence.js',
  'lib/tools.js',
  'lib/core/fold.js',
  'lib/core/text.js',
  'lib/core/window.js',
  'locale/en.json',
  'locale/zh.json',
  'scripts/preflight.mjs',
];
for (const relative of required) {
  if (!existsSync(join(root, relative))) fail(`required file is missing: ${relative}`);
}

// --- 4. screenshots.json ----------------------------------------------------
const screenshots = readJson('screenshots.json');
if (screenshots !== null) {
  if (!Array.isArray(screenshots) || screenshots.length < 1 || screenshots.length > 8) {
    fail('screenshots.json must list 1–8 relative screenshots');
  } else {
    for (const entry of screenshots) {
      if (typeof entry !== 'string' || entry.startsWith('/') || entry.includes('..')) {
        fail(`screenshots.json entry must be a relative path without "..": ${entry}`);
        continue;
      }
      if (!existsSync(join(root, entry))) fail(`screenshots.json entry does not exist: ${entry}`);
    }
  }
}

// --- 5. packaged file list --------------------------------------------------
let packFiles = [];
let packSize = 0;
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const raw = execFileSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    // .cmd shims need a shell on Windows; plain execFileSync spawns EINVAL there.
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(raw);
  // npm < 11 prints an array of packed packages; npm 12 prints an object keyed
  // by package name. Accept both shapes.
  const entry = Array.isArray(parsed)
    ? parsed[0]
    : (parsed[pkg?.name] ?? Object.values(parsed)[0]);
  packFiles = (entry?.files ?? []).map((file) => file.path);
  packSize = entry?.size ?? 0;
} catch (error) {
  fail(`npm pack --dry-run failed: ${error.stderr?.trim() || error.message}`);
}

if (packFiles.length > 0) {
  const mustShip = [
    'package.json',
    'lib/index.js',
    'lib/client.js',
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'README.zh.md',
    'CHANGELOG.md',
    'LICENSE',
    'screenshots.json',
    'docs/screenshots/cover-16x9.png',
    'docs/screenshots/shot-01-default.png',
    'docs/screenshots/shot-04-settings.png',
  ];
  for (const relative of mustShip) {
    if (!packFiles.includes(relative)) fail(`npm package is missing ${relative}`);
  }
  const forbidden = /(^|\/)(raw-|\.tmp|tests\/|scripts\/|market\/|\.github\/)/;
  for (const relative of packFiles) {
    if (forbidden.test(relative)) fail(`npm package must not contain ${relative}`);
  }
  if (packSize > 5 * 1024 * 1024) {
    fail(`npm tarball is ${packSize} bytes, expected under 5 MiB`);
  }
  // The screenshots referenced by the README must actually ship.
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  for (const match of readme.matchAll(/\((docs\/screenshots\/[^)]+)\)/g)) {
    if (!packFiles.includes(match[1])) fail(`README references ${match[1]} but npm would not ship it`);
  }
  for (const match of readme.matchAll(/^!\[[^\]]*\]\((icon\.svg)\)/gm)) {
    if (!packFiles.includes(match[1])) fail(`README references ${match[1]} but npm would not ship it`);
  }
  notes.push(`npm package: ${packFiles.length} files, ${(packSize / 1024).toFixed(1)} KiB`);
}

// --- 6. host tests visibility ----------------------------------------------
try {
  await import.meta.resolve('@deepseek-ai/dsh-client-ui-conversation');
  notes.push('Harness packages resolvable: host-wiring/host-schema tests will run in full');
} catch {
  notes.push(
    'Harness packages not resolvable here: host-wiring/host-schema tests report 12 explicit skips (expected outside a DSH profile)',
  );
}

// --- report ----------------------------------------------------------------
console.log('dsh-time-pin preflight');
for (const note of notes) console.log(`  note: ${note}`);
if (problems.length === 0) {
  console.log('  OK: all checks passed');
  process.exit(0);
}
for (const problem of problems) console.error(`  FAIL: ${problem}`);
process.exit(1);
