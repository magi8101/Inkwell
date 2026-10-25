// Run: node scripts/make-inkw-golden.ts — writes the golden .inkw sample and what it must decode to.
// Golden files are committed; they guard the format against accidental change (inkw.check.ts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { packBackup } from '../src/backup.ts';
import { readInkw, writeInkw } from '../src/inkw.ts';
import { plain, SAMPLE_PNG_HASH, sampleDocument, sampleStrokes } from '../src/inkw-sample.ts';

const dir = new URL('../docs/inkw-golden/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const { bytes } = await writeInkw(sampleDocument(SAMPLE_PNG_HASH));
writeFileSync(`${dir}basic.inkw`, bytes);
writeFileSync(`${dir}basic.expected.json`, `${JSON.stringify(plain(await readInkw(bytes)), null, 1)}\n`);
console.log(`wrote ${dir}basic.inkw (${bytes.length} bytes)`);

// A backup in the old .inkbackup format (before backups became .inkw): restore must keep reading it.
const legacy = packBackup(
  [
    {
      id: 'n1',
      name: 'Legacy',
      sections: [
        {
          id: 's1',
          name: 'Old folder',
          color: '#3e63dd',
          pages: [{ id: 'p1', title: 'Old page', strokes: sampleStrokes('l', 6, 5), texts: [], images: [], background: 'blank', pageColor: 'auto' }],
        },
      ],
    },
  ],
  [],
);
writeFileSync(`${dir}legacy.inkbackup`, legacy);
console.log(`wrote ${dir}legacy.inkbackup (${legacy.length} bytes)`);
