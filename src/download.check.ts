// Run: node src/download.check.ts — the /download links send each device to the right installer.
import assert from 'node:assert/strict';
import { detect, download } from '../worker/download.ts';

const github = (async () => Response.json({ version: '0.2.3' })) as typeof fetch;
const down = (async () => new Response('', { status: 502 })) as typeof fetch;
const req = (path: string, ua = '') =>
  new Request(`https://x.test/download${path}`, { headers: { 'User-Agent': ua } });
const V = 'https://github.com/magi8101/Inkwell/releases/download/v0.2.3';

const UA = {
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Fedora; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
};
assert.equal(detect(UA.android), 'android'); // before Linux: Android says "Linux" too
assert.equal(detect(UA.iphone), 'ios'); // before Mac: iOS says "like Mac OS X"
assert.equal(detect(UA.linux), 'linux');
assert.equal(detect('curl/8'), null);

const to = async (r: Promise<Response>) => (await r).headers.get('Location');
assert.equal(await to(download(req('', UA.win), github)), `${V}/Inkwell_0.2.3_x64-setup.exe`);
assert.equal(await to(download(req('', UA.mac), github)), `${V}/Inkwell_0.2.3_universal.dmg`);
assert.equal(await to(download(req('', UA.android), github)), `${V}/Inkwell_0.2.3_android.apk`);
assert.equal(await to(download(req('/rpm'), github)), `${V}/Inkwell-0.2.3-1.x86_64.rpm`);
assert.equal(await to(download(req('/linux'), github)), `${V}/Inkwell_0.2.3_amd64.AppImage`);

// Linux, iPhone and unknown devices get the page, with the AppImage steps.
for (const ua of [UA.linux, UA.iphone, 'curl/8']) {
  const r = await download(req('', ua), github);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /chmod \+x Inkwell_\*\.AppImage/);
}
assert.equal((await download(req('/nope'), github)).status, 404);
// GitHub unreachable → the Releases page.
assert.equal(
  await to(download(req('', UA.win), down)),
  'https://github.com/magi8101/Inkwell/releases/latest',
);
console.log('download checks passed');
