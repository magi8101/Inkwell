// Writes the GitHub release title and notes for a version tag.
// Usage: node scripts/release-notes.mjs v0.2.0 [notes.md]   → prints the title; notes go to the file.
//
// Every release gets a name, like Ubuntu's: the Nth release takes the Nth name below (A to Z, then
// a second A to Z, then the list again with "II", "III"…), so names never repeat and read in order.
// The notes are built from the commits since the previous release: new features, fixes and other
// changes, each with its full explanation from the commit message.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const NAMES = [
  'Amber Albatross', 'Brisk Badger', 'Cobalt Crane', 'Dapper Dolphin', 'Ember Eagle',
  'Feather Fox', 'Golden Gecko', 'Hazel Heron', 'Indigo Ibis', 'Jade Jaguar',
  'Kindle Kestrel', 'Lunar Lynx', 'Maple Marten', 'Nimble Narwhal', 'Onyx Otter',
  'Pebble Panda', 'Quartz Quail', 'Ruby Raven', 'Saffron Swift', 'Tidal Tern',
  'Umber Urchin', 'Velvet Vole', 'Willow Wren', 'Xenon Xerus', 'Yarrow Yak', 'Zephyr Zebra',
  'Agile Antelope', 'Bramble Bison', 'Cedar Cougar', 'Dusky Dove', 'Elder Elk',
  'Frost Finch', 'Granite Gull', 'Harbor Hare', 'Ivory Iguana', 'Juniper Jay',
  'Kelp Koala', 'Lichen Lark', 'Misty Moose', 'Nectar Newt', 'Opal Owl',
  'Pine Puffin', 'Quiet Quokka', 'Rustic Robin', 'Silver Seal', 'Thistle Tiger',
  'Upland Urial', 'Vivid Viper', 'Wild Walrus', 'Xeric Xenops', 'Yukon Yellowfin', 'Zinc Zebu',
];
/** Inkwell's permanent signing key (public half), the same for every release. */
const PUBKEY = 'RWQ9VllfUIRcViloBPWKvQG4YH8+aZh0EElUNXB5v3/S5AMQtb37td1U';
const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];

export function releaseName(index) {
  const round = Math.floor(index / NAMES.length);
  return `${NAMES[index % NAMES.length]}${ROMAN[round] ?? ` ${round + 1}`}`;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const semver = (tag) => tag.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
const cmp = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** What kind of update this is, in words. */
function kind(prev, tag) {
  if (!prev) return 'First release';
  const [a, b] = [semver(prev), semver(tag)];
  if (b[0] > a[0]) return 'Major update: big changes; check the notes before updating';
  if (b[1] > a[1]) return 'Feature update: new things to try, plus fixes';
  return 'Patch: fixes and small improvements';
}

/** Sorts a commit into a section by what its subject and explanation say it does. */
function section({ subject, text }) {
  if (/^(release|bump|ci|docs?|readme|chore|test|lint|format)\b/i.test(subject)) return 'other';
  if (/^(fix|fixes|fixed|repair|correct)\b/i.test(subject)) return 'fixes';
  const fixWords = /\b(bug|crash\w*|broke\w*|failed|no longer|couldn't|wasn't|didn't|cut off|wrong)\b/i;
  return fixWords.test(subject) || fixWords.test(text) ? 'fixes' : 'features';
}

function main() {
  const tag = process.argv[2];
  const out = process.argv[3] ?? 'release-notes.md';
  if (!/^v\d+\.\d+\.\d+/.test(tag ?? '')) throw new Error(`expected a tag like v1.2.3, got ${tag}`);
  const earlier = git('tag', '--list', 'v*')
    .split('\n')
    .filter((t) => /^v\d+\.\d+\.\d+/.test(t) && cmp(t, tag) < 0)
    .sort(cmp);
  const prev = earlier.at(-1);
  const name = releaseName(earlier.length);
  const range = prev ? `${prev}..${tag}` : tag;
  const SEP = '\u001e';
  const log = git('log', '--no-merges', `--format=%h%x1f%s%x1f%b${SEP}`, range);
  const commits = log
    .split(SEP)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [hash, subject, body = ''] = c.split('\u001f');
      // Trailer lines (Signed-off-by etc.) aren't part of the explanation.
      const text = body.split('\n').filter((l) => !/^[\w-]+: /.test(l)).join(' ').replace(/\s+/g, ' ').trim();
      return { hash, subject, text };
    });
  const groups = { features: [], fixes: [], other: [] };
  for (const c of commits) groups[section(c)].push(c);
  const list = (cs) => cs.map((c) => `- **${c.subject}** (${c.hash})${c.text ? `\n  ${c.text}` : ''}`).join('\n');

  const notes = [
    `## Inkwell ${tag.slice(1)} “${name}”`,
    '',
    `**${kind(prev, tag)}.** ${commits.length} change${commits.length === 1 ? '' : 's'} since ${prev ?? 'the start'}: ${groups.features.length} new or improved, ${groups.fixes.length} fixed.`,
    '',
    ...(groups.features.length ? ['### New and improved', list(groups.features), ''] : []),
    ...(groups.fixes.length ? ['### Fixes', list(groups.fixes), ''] : []),
    ...(groups.other.length ? ['### Behind the scenes', list(groups.other), ''] : []),
    '### Download',
    '| System | File |',
    '| --- | --- |',
    '| Windows 10/11 | `Inkwell_*_x64-setup.exe` (installer, no admin needed) or `Inkwell_*_x64_en-US.msi` |',
    '| macOS (Apple Silicon and Intel) | `Inkwell_*_universal.dmg` |',
    '| Linux | `Inkwell_*_amd64.AppImage` (any distro), `.deb` (Ubuntu, Debian, Pop!_OS), `.rpm` (Fedora) |',
    '| Android phones and tablets | `Inkwell_*_android.apk` |',
    '',
    'These builds aren\'t code-signed yet, so the first launch needs one extra step:',
    '- **Windows:** if SmartScreen says "Windows protected your PC", click *More info* → *Run anyway*.',
    '- **macOS:** right-click the app → *Open* → *Open*. If it says the app is damaged, run `xattr -cr /Applications/Inkwell.app` in Terminal.',
    '- **Linux AppImage:** `chmod +x Inkwell_*.AppImage`, then run it.',
    '- **Android:** open the APK and allow installing from this source when asked. If an older Inkwell is installed and Android refuses, uninstall it first.',
    '',
    '### Check a download',
    "Every file is listed in `SHA256SUMS.txt`, signed with Inkwell's permanent key (`SHA256SUMS.txt.minisig`). With [minisign](https://jedisct1.github.io/minisign/):",
    '```',
    `minisign -Vm SHA256SUMS.txt -P ${PUBKEY}`,
    'sha256sum --ignore-missing -c SHA256SUMS.txt',
    '```',
    '',
    'Prefer no install? The same app runs in the browser at https://inkwell.sharmamagi0.workers.dev.',
    '',
    prev ? `**Full list of changes:** https://github.com/magi8101/Inkwell/compare/${prev}...${tag}` : '',
  ].join('\n');
  writeFileSync(out, notes);
  console.log(`Inkwell ${tag.slice(1)} “${name}”`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
