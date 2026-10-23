// /download: one link that gets the right Inkwell installer for whoever opens it, so nobody has
// to find the GitHub Releases page. Windows, Mac and Android go straight to the file; Linux and
// iPhone/iPad get a short page (Linux needs two steps, iOS has no app: it's the website).
//   /download            the installer for this device
//   /download/<kind>     windows | msi | mac | linux | rpm | deb | android  (always the newest)
//   /download/all        every download, with notes
// The newest version comes from the update file the apps already read (latest.json on the newest
// GitHub release), which has no API rate limit; file names follow the version.

const REPO = 'magi8101/Inkwell';
const RELEASES = `https://github.com/${REPO}/releases/latest`;

const FILES = {
  windows: (v: string) => `Inkwell_${v}_x64-setup.exe`,
  msi: (v: string) => `Inkwell_${v}_x64_en-US.msi`,
  mac: (v: string) => `Inkwell_${v}_universal.dmg`,
  linux: (v: string) => `Inkwell_${v}_amd64.AppImage`,
  rpm: (v: string) => `Inkwell-${v}-1.x86_64.rpm`,
  deb: (v: string) => `Inkwell_${v}_amd64.deb`,
  android: (v: string) => `Inkwell_${v}_android.apk`,
} as const;
type Kind = keyof typeof FILES;
const isKind = (s: string): s is Kind => s in FILES;

/** What the visitor is using, from the browser's own description. */
export function detect(ua: string): Kind | 'ios' | null {
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return null;
}

async function newestVersion(get: typeof fetch): Promise<string> {
  const res = await get(`https://github.com/${REPO}/releases/latest/download/latest.json`, {
    // A few minutes' cache: a new release shows up quickly, and GitHub isn't asked every time.
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  const v = ((await res.json()) as { version?: string }).version;
  if (!v || !/^\d+\.\d+\.\d+$/.test(v)) throw new Error('no version in latest.json');
  return v;
}

const fileUrl = (kind: Kind, v: string) =>
  `https://github.com/${REPO}/releases/download/v${v}/${FILES[kind](v)}`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function page(v: string, focus: Kind | 'ios' | null): Response {
  const card = (kind: Kind, title: string, body: string, big = false) =>
    `<section${focus === kind ? ' class="here"' : ''}><h2>${title}</h2>${body}<a class="${
      big ? 'btn' : 'link'
    }" href="/download/${kind}">Download ${esc(FILES[kind](v))}</a></section>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Get Inkwell</title>
<style>
:root{--bg:#f4f4f5;--card:#fff;--text:#18181b;--dim:#5b5b65;--accent:#2563eb;--line:rgba(0,0,0,.1)}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e10;--card:#1f1f22;--text:#f4f4f5;--dim:#a8a8b2;--accent:#60a5fa;--line:rgba(255,255,255,.1)}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 64px}
h1{margin:8px 0 4px}p{margin:6px 0;color:var(--dim)}
section{margin:16px 0;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--card)}
section.here{border-color:var(--accent)}h2{margin:0 0 4px;font-size:18px}
code{padding:1px 6px;border-radius:6px;background:var(--bg);font-size:14px;overflow-wrap:anywhere}
.btn{display:block;margin-top:12px;padding:14px;border-radius:12px;background:var(--accent);color:#fff;text-align:center;font-weight:600;text-decoration:none;overflow-wrap:anywhere}
.link{display:inline-block;margin-top:8px;color:var(--accent);overflow-wrap:anywhere}
</style></head><body><main>
<h1>Get Inkwell</h1><p>Version ${esc(v)}. The website works in any browser: <a class="link" href="/">open it</a>.
Once an app is installed it tells you when a new version is out and updates itself.</p>
${
  focus === 'ios'
    ? `<section class="here"><h2>iPhone and iPad</h2><p>There's no app to install: open <a class="link" href="/">${esc(
        'the website',
      )}</a> in Safari, tap Share, then <b>Add to Home Screen</b>.</p></section>`
    : ''
}
${card(
  'linux',
  'Linux (recommended: AppImage)',
  `<p>Updates itself, no admin password. After downloading, open a terminal in the Downloads folder and run <code>chmod +x Inkwell_*.AppImage</code>, then double-click it, or <code>./Inkwell_*.AppImage</code>.</p>
<p>If it won't start on Fedora: <code>sudo dnf install fuse-libs</code>.</p>`,
  focus === 'linux',
)}
${card('windows', 'Windows', '<p>Run the installer; no admin rights needed.</p>', focus === 'windows')}
${card('mac', 'Mac', '<p>Open the disk image and drag Inkwell to Applications. The first time, right-click it and choose Open.</p>')}
${card('android', 'Android', '<p>Open the file; allow installing from this browser if asked. A new version installs over the old one.</p>', focus === 'android')}
<section><h2>Other</h2><p>Linux packages (installing and updating them asks for the admin password):</p>
<a class="link" href="/download/rpm">Fedora / openSUSE (.rpm)</a><br><a class="link" href="/download/deb">Ubuntu / Debian (.deb)</a><br>
<a class="link" href="/download/msi">Windows (.msi)</a><br><a class="link" href="${RELEASES}">All files on GitHub</a></section>
</main></body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

export async function download(req: Request, get: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const what = url.pathname.replace(/^\/download\/?/, '').toLowerCase();
  try {
    const v = await newestVersion(get);
    if (what === 'all') return page(v, null);
    if (isKind(what)) return Response.redirect(fileUrl(what, v), 302);
    if (what) return new Response('Not found', { status: 404 });
    const mine = detect(req.headers.get('User-Agent') ?? '');
    // Windows, Mac and Android installers explain themselves; the others get the page.
    if (mine === 'windows' || mine === 'mac' || mine === 'android') {
      return Response.redirect(fileUrl(mine, v), 302);
    }
    return page(v, mine);
  } catch {
    // GitHub unreachable: the Releases page still works.
    return Response.redirect(RELEASES, 302);
  }
}
