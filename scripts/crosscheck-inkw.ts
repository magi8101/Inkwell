// Run: node scripts/crosscheck-inkw.ts — the TypeScript reader and the Python reader (tools/inkw.py)
// must decode every golden .inkw file to the same strokes, pictures and page data. Skipped, with a
// notice, where python3 is not installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { readInkw } from '../src/inkw.ts';

const root = new URL('../', import.meta.url).pathname;
const probe = spawnSync('python3', ['--version']);
if (probe.error) {
  console.log('python3 not available: cross-language check skipped');
  process.exit(0);
}
const golden = `${root}docs/inkw-golden/`;
const files = readdirSync(golden).filter((f) => f.endsWith('.inkw'));
assert.ok(files.length > 0, 'golden files exist');
for (const f of files) {
  const py = spawnSync('python3', ['-I', `${root}tools/inkw.py`, 'dump', `${golden}${f}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(py.status, 0, `python could not read ${f}: ${py.stderr}`);
  const theirs = JSON.parse(py.stdout);
  const ours = await readInkw(new Uint8Array(readFileSync(`${golden}${f}`)));
  assert.deepEqual(theirs.pages.map((p: { id: string }) => p.id).sort(), ours.pages.map((p) => p.id).sort(), `${f}: same pages`);
  for (const p of ours.pages) {
    const q = theirs.pages.find((x: { id: string }) => x.id === p.id);
    assert.deepEqual(q.json, p.json, `${f} ${p.id}: same page.json`);
    assert.equal(q.strokes.length, p.strokes.length, `${f} ${p.id}: stroke count`);
    p.strokes.forEach((s, i) => {
      const t = q.strokes[i];
      assert.deepEqual([t.id, t.tool, t.color, t.width, t.opacity, t.pressure], [s.id, s.tool, s.color, s.width, s.opacity, s.pressure], `${f} ${p.id} stroke ${i}`);
      assert.equal(t.points.length * 3, s.points.length, 'point count');
      t.points.forEach((pt: number[], k: number) => {
        for (let c = 0; c < 3; c++) assert.ok(Math.abs(pt[c]! - s.points[k * 3 + c]!) < 1e-9, `${f} ${p.id} stroke ${i} point ${k}`);
      });
    });
  }
  assert.deepEqual(Object.keys(theirs.blobs).sort(), [...ours.blobs.keys()].sort(), `${f}: same pictures`);
  assert.deepEqual(theirs.notebooks, ours.notebooks.map((n) => n.json), `${f}: same notebooks`);
}
// Python refuses what is not a file of ours, with the same plain message.
for (const bad of ['docs/inkw-golden/legacy.inkbackup', 'package.json']) {
  const r = spawnSync('python3', ['-I', `${root}tools/inkw.py`, 'info', `${root}${bad}`], { encoding: 'utf8' });
  assert.equal(r.status, 1, `${bad} is refused`);
  assert.match(r.stderr, /Not an Inkwell file/);
}
// And it enforces the spec's limits on hostile files, as the TypeScript reader does.
const hostile = `
import io, json, sys, zipfile
sys.path.insert(0, ${JSON.stringify(`${root}tools`)})
import inkw
MIME = inkw.MIME
def make(entries, dup=False):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(name, data)
    return buf.getvalue()
head = lambda major=1: [("mimetype", MIME), ("inkw.json", json.dumps({"format": "inkw", "version": {"major": major, "minor": 0}, "notebooks": []}))]
def refused(data, why):
    try:
        inkw.read(data)
    except inkw.InkwError:
        return
    sys.exit("not refused: " + why)
inkw.read(make(head()))  # a valid file reads
refused(make(head() + [("../x", "1")]), "unsafe name")
refused(make(head() + [("/abs", "1")]), "absolute name")
refused(make(head() + [("a\\\\b", "1")]), "backslash name")
refused(make(head() + [("a.bin", "1"), ("a.bin", "2")]), "duplicate name")
refused(make(head(2)), "newer major")
refused(b"INKWLK1" + bytes(41), "locked file")
inkw.LIMITS["entry_bytes"] = 1000
refused(make(head() + [("big.bin", bytes(5000))]), "oversized entry")
print("python hostile checks passed")
`;
const h = spawnSync('python3', ['-I', '-c', hostile], { encoding: 'utf8' });
assert.equal(h.status, 0, h.stderr || h.stdout);
console.log(`cross-language check passed (${files.length} golden file${files.length === 1 ? '' : 's'})`);
