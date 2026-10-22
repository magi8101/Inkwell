// Starts a release: bumps the version everywhere it's written, commits, tags and pushes. The tag
// makes GitHub Actions build Windows, macOS and Linux apps and publish them (release.yml).
// Usage: npm run release -- patch | minor | major | 1.4.0

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit' });
const arg = process.argv[2];
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const next =
  arg === 'major' ? `${major + 1}.0.0`
  : arg === 'minor' ? `${major}.${minor + 1}.0`
  : arg === 'patch' ? `${major}.${minor}.${patch + 1}`
  : /^\d+\.\d+\.\d+$/.test(arg ?? '') ? arg
  : null;
if (!next) {
  console.error('Usage: npm run release -- patch | minor | major | 1.4.0');
  process.exit(1);
}
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) {
  console.error('Commit or stash your changes first.');
  process.exit(1);
}

const edit = (file, from, to) => {
  const text = readFileSync(file, 'utf8');
  if (!from.test(text)) throw new Error(`no version found in ${file}`);
  writeFileSync(file, text.replace(from, to));
};
edit('package.json', /"version": "[^"]+"/, `"version": "${next}"`);
edit('src-tauri/tauri.conf.json', /"version": "[^"]+"/, `"version": "${next}"`);
edit('src-tauri/Cargo.toml', /^version = "[^"]+"/m, `version = "${next}"`);
edit('src-tauri/Cargo.lock', /(name = "inkwell"\nversion = )"[^"]+"/, `$1"${next}"`);
run('npm', 'install', '--package-lock-only', '--silent');

run('git', 'add', 'package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock');
run('git', 'commit', '-m', `Release v${next}`);
run('git', 'tag', '-a', `v${next}`, '-m', `Inkwell ${next}`);
run('git', 'push', '--follow-tags');
console.log(`\nv${next} pushed. GitHub Actions is building it: https://github.com/magi8101/Inkwell/actions`);
