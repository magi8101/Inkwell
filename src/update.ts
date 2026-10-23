import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { h, toast } from './dom';
import { saveNow } from './store';

// "A new version is out" for the installed apps (the website is always up to date). Desktop uses
// Tauri's updater: it reads latest.json from the newest GitHub release, checks the download against
// Inkwell's signing key, installs it and restarts. Android can't replace itself, so it opens the
// new APK's download and Android asks to install it over this one (same signing key).

const RELEASES = 'https://github.com/magi8101/Inkwell/releases/latest';
const IN_APP = '__TAURI_INTERNALS__' in window;
const ANDROID = /Android/.test(navigator.userAgent);

function offer(version: string, install: () => Promise<void>) {
  const bar = h(
    'div',
    { class: 'toast update-bar', role: 'status' },
    h('span', {}, `Inkwell ${version} is out.`),
    h('button', { class: 'cal-btn', onclick: () => bar.remove() }, 'Later'),
    h(
      'button',
      {
        class: 'cal-btn update-go',
        onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          btn.textContent = 'Updating…';
          try {
            await install();
            bar.remove();
          } catch {
            // e.g. a Linux .deb install, which the updater can't replace: the page has every file.
            bar.remove();
            toast('Couldn’t update here — opening the download page.', 4000);
            await openUrl(RELEASES).catch(() => {});
          }
        },
      },
      'Update',
    ),
  );
  document.body.append(bar);
}

async function desktop() {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return;
  offer(update.version, async () => {
    await saveNow(); // the installer closes the app
    await update.downloadAndInstall();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  });
}

async function android() {
  const res = await fetch('https://api.github.com/repos/magi8101/Inkwell/releases/latest');
  if (!res.ok) return;
  const rel = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  const latest = rel.tag_name.replace(/^v/, '');
  if (latest.localeCompare(await getVersion(), undefined, { numeric: true }) <= 0) return;
  const apk = rel.assets.find((a) => a.name.endsWith('_android.apk'));
  offer(latest, () => openUrl(apk?.browser_download_url ?? RELEASES));
}

// A few seconds in, so starting up and the first strokes aren't competing with the check.
// Offline or GitHub unreachable: say nothing, try again next start.
if (IN_APP) setTimeout(() => void (ANDROID ? android() : desktop()).catch(() => {}), 5000);
