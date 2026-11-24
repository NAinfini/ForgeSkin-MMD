import { app, autoUpdater, BrowserWindow, dialog, ipcMain, net, protocol, shell, type OpenDialogOptions } from 'electron';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import squirrelStartup from 'electron-squirrel-startup';
import { Backend } from './backend';
import { bakeDance, blenderVersion, findBlender, type BakeRequest } from './dance';
import { dataDir, edition, moveData, moveInstallData } from './dataDir';

// The installer runs the app once per install, update and uninstall to make or remove its shortcuts; it quits then. The
// portable copy has no installer.
const squirrelRun = edition === 'installed' && squirrelStartup;
if (squirrelRun) app.quit();

// Moves the pre-rename Electron profile (GTFO Skin Forge -> ForgeSkin: preferences, panel layout, last weapon) to the
// new app name before Chromium opens it; once moved there is nothing left to move. Electron has already created the new
// folder by now, so the old one is copied in and then removed.
function movePreRenameUserData(): void {
  const old = join(app.getPath('appData'), 'GTFO Skin Forge');
  const now = app.getPath('userData');
  if (!existsSync(old) || existsSync(join(now, 'Local Storage'))) return;
  cpSync(old, now, { recursive: true });
  rmSync(old, { recursive: true, force: true });
}
movePreRenameUserData();

// Chromium's HTTP disk cache only ever holds what comes over http (a development run's modules): the app's own files are
// file:// and sf:// and never cached. Kept small.
app.commandLine.appendSwitch('disk-cache-size', String(32 << 20));

// A development door for testing: with FORGESKIN_CDP_PORT set, Chromium serves the DevTools protocol on that port and the
// window can be screenshotted and driven without touching the real mouse or stealing focus. A plain run never sets it.
if (process.env.FORGESKIN_CDP_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.FORGESKIN_CDP_PORT);

/**
 * V8's code cache keeps the compiled scripts of every app version (and development build): deleted when the version
 * changes or it passes 128 MB, before Chromium opens it (the session starts when the app is ready).
 */
function trimCodeCache(): void {
  const mark = join(app.getPath('userData'), 'code-cache-version');
  const dir = join(app.getPath('userData'), 'Code Cache');
  const files = existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()) : [];
  const size = files.reduce((sum, e) => sum + statSync(join(e.parentPath, e.name)).size, 0);
  if (existsSync(mark) && readFileSync(mark, 'utf8') === app.getVersion() && size <= 128 << 20) return;
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(mark, app.getVersion());
}
try {
  trimCodeCache();
} catch (e) {
  appLog('code cache', e);
}

// Local files (preview GLB, textures, videos) are served to the renderer as sf://local/<abs path>, never kept in the HTTP
// cache (the backend's own cache already holds them).
protocol.registerSchemesAsPrivileged([{ scheme: 'sf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win: BrowserWindow | null = null;
let quitting = false;
// The backend is stopped on purpose while the data folder moves.
let moving = false;
let startedAt = 0;
let crashes = 0;
// The window can be gone while the app shuts down (the backend exits after it).
const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

/** Crash and error evidence: one line per event in GTFO_UserData/logs/app.log, written synchronously so it survives the crash. */
function appLog(kind: string, detail: unknown) {
  const text =
    detail instanceof Error
      ? `${detail.message}
${detail.stack}`
      : typeof detail === 'string'
        ? detail
        : JSON.stringify(detail);
  try {
    const dir = join(dataDir(), 'logs');
    mkdirSync(dir, { recursive: true });
    // Past 2 MB the log moves to app.1.log (the older ones to .2 and .3, the oldest dropped), as the backend's backend.log.
    const file = join(dir, 'app.log');
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 2 << 20)
      for (let i = 3; i >= 1; i--) {
        const from = i === 1 ? file : join(dir, `app.${i - 1}.log`);
        if (existsSync(from)) renameSync(from, join(dir, `app.${i}.log`));
      }
    appendFileSync(
      file,
      `${new Date().toISOString()} [${kind}] ${text}
`,
    );
  } catch {
    // nowhere left to report it
  }
}

process.on('uncaughtException', (e) => appLog('main uncaughtException', e));
process.on('unhandledRejection', (e) => appLog('main unhandledRejection', e));
app.on('child-process-gone', (_e, d) => appLog('child-process-gone', d));

const backend = new Backend(
  (event, data) => send('backend:event', event, data),
  (line) => send('backend:log', line),
  (code) => {
    send('backend:log', `backend exited (${code})`);
    if (quitting || moving) return;
    // Restart, but give up after repeated crashes right after start (shown to the user as "down").
    crashes = Date.now() - startedAt < 10_000 ? crashes + 1 : 0;
    if (crashes >= 3) return send('backend:status', 'down');
    send('backend:status', 'restarting');
    setTimeout(startBackend, 1000);
  },
);

function startBackend() {
  startedAt = Date.now();
  // Ready only once the process exists; an exe that is missing never reports ready.
  backend.start(() => send('backend:status', 'ready'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#15171a',
    title: 'ForgeSkin',
    // The packaged exe carries the icon (packagerConfig.icon); from source the window takes it from assets/.
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'assets', 'icon.ico'),
    // Frameless; the top bar draws its own minimize / maximize / close (see `win:*` below).
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));
  // A dead renderer is reloaded; the store then reopens the last weapon from its autosave.
  win.webContents.on('render-process-gone', (_e, d) => {
    appLog('render-process-gone', d);
    if (d.reason !== 'clean-exit' && !quitting) setTimeout(() => win?.webContents.reload(), 500);
  });
  win.webContents.on('unresponsive', () => appLog('renderer unresponsive', ''));
  // The renderer's own errors and warnings go to the app log: a character that fails to open leaves the panel empty, and the
  // reason (a thrown message, a refused call) was otherwise only visible in a devtools console nobody keeps open.
  win.webContents.on('console-message', (e) => {
    if (e.level !== 'error' && e.level !== 'warning') return;
    appLog(`renderer ${e.level}`, `${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  // A first load can fail (a cold dev server, a crashed network service) and would leave the window blank: retry a few times.
  let loadTries = 0;
  let loaded = false;
  const load = () =>
    (MAIN_WINDOW_VITE_DEV_SERVER_URL ? win?.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL) : win?.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)))?.catch(() => {});
  const retry = (why: unknown) => {
    if (quitting) return;
    appLog('did-fail-load', { why, try: loadTries + 1 });
    if (++loadTries > 5) return appLog('did-fail-load', 'gave up after 5 retries');
    setTimeout(load, 1000);
  };
  win.webContents.on('did-finish-load', () => (loaded = true));
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // -3 (aborted) is skipped only while a newer navigation goes on; one aborted by a crashed network service leaves nothing loading.
    if (isMainFrame && (code !== -3 || !win?.webContents.isLoading())) retry({ code, url });
  });
  // A network service that crashes before the first page is up can end that load without any did-fail-load.
  app.on('child-process-gone', (_e, d) => {
    if (!loaded && d.serviceName === 'network.mojom.NetworkService') retry('network service crashed');
  });
  load();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// The renderer may only write files inside the data dir (autosaved skins and their frames live there), and next to a skin
// project saved elsewhere (a folder holding a .forgeskinproj) its generated frames (`.frames/`) and converted sounds
// (`sounds/*.ogg`).
function writable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const p = normalize(path);
  if (p.startsWith(resolve(dataDir()) + sep)) return true;
  const dirs = p.split(sep);
  const frames = dirs.indexOf('.frames');
  const project = frames > 0 && /\.(png|json)$/i.test(p) ? dirs.slice(0, frames) : dirs.at(-2) === 'sounds' && p.endsWith('.ogg') ? dirs.slice(0, -2) : null;
  try {
    return !!project && readdirSync(project.join(sep)).some((f) => f.endsWith('.forgeskinproj'));
  } catch {
    return false;
  }
}

// sf:// serves what the editor shows (textures, models, videos, sounds, fonts, and a character work's converted model: its
// descriptor and mesh, drawn when the work came from a pack) wherever the user keeps them, and no other kind of file.
const SERVED = /\.(png|jpe?g|tga|tiff?|bmp|webp|gif|exr|mp4|webm|mov|m4v|wav|mp3|ogg|flac|m4a|aac|opus|ttf|otf|woff2?|glb|gltf|vrm|bin|forgemesh|dance|cam|vmd|danceproj)$|[\\/]character[\\/]model\.json$/i;

// The development editor installs the plugin built from this checkout: before an install the user asked for, it runs
// build-editor-release.ps1 -PluginOnly, which builds ForgeSkin and ForgeCore from source and stages
// artifacts/forge-skin-release/publish/plugin for the backend. Nothing has to be packaged first. The script's whole output goes
// to app.log; the window gets its last lines, the failed step as PowerShell's error box says it, for the log line it writes.
async function stageDevPlugin(): Promise<{ ok: true } | { ok: false; reason: 'notDev' | 'failed'; detail?: string }> {
  if (edition !== 'dev') return { ok: false, reason: 'notDev' };
  // MMD 版是独立仓库布局：ForgeSkin/ 就在仓库根（没有 Mods/），也没有 PowerShell 7，跑不了上游那份打包脚本。
  // 插件由 ForgeSkin/tools/stage-plugin-standalone.py 从源码构建并暂存到 artifacts/forge-skin-release/publish/plugin
  // （见 CHANGELOG-MMD.md 第 3 节），这里直接用构建好的那一份；C# 改动后重跑那个脚本即可。
  const checkout = join(app.getAppPath(), '..', '..');
  const staged = join(checkout, 'artifacts', 'forge-skin-release', 'publish', 'plugin');
  if (['ForgeSkin/ForgeSkin.Plugin.dll', 'ForgeCore/ForgeCore.dll'].every((file) => existsSync(join(staged, ...file.split('/'))))) {
    appLog('plugin stage', `reusing the plugin built from source at ${staged}`);
    return { ok: true };
  }
  const root = join(app.getAppPath(), '..', '..', '..');
  const script = join(root, 'Mods', 'ForgeSkin', 'tools', 'build-editor-release.ps1');
  const tail = (text: string, n: number) =>
    text
      .split('\n')
      .map((l) => l.replace(/^\s*\|\s?/, '').trim())
      .filter((l) => l && !/^[~\s]+$/.test(l) && !/^Line\s*\|?$/.test(l) && !/^\d+\s*\|/.test(l) && !/^Exception:/.test(l))
      .slice(-n);
  return new Promise((done) =>
    execFile('pwsh', ['-NoProfile', '-File', script, '-PluginOnly'], { cwd: root, windowsHide: true, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
      appLog('plugin stage', `${script} -PluginOnly: ${error ? 'failed' : 'ok'}\n${stdout}${stderr}`);
      done(error ? { ok: false, reason: 'failed', detail: [...tail(stdout, 2), ...tail(stderr, 1)].join('\n') } : { ok: true });
    }),
  );
}

function registerIpc() {
  // IPC turns a rejected plain object into "[object Object]", so backend errors travel as a value and preload rethrows them.
  ipcMain.handle('backend:call', (_e, method: string, params: unknown) =>
    backend.call(method, params).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    ),
  );
  ipcMain.handle('app:dataDir', () => dataDir());
  ipcMain.handle('app:edition', () => edition);
  ipcMain.handle('plugin:stage', () => stageDevPlugin());
  // Blender, where the bake kit's script runs: the dance's 50 joints are solved the way MMD solves them.
  ipcMain.handle('dance:blender', async (_e, preferred?: string) => {
    const file = findBlender(preferred);
    return file ? { file, version: await blenderVersion(file) } : null;
  });
  // A picked source file (a VMD, a song) is copied into the dance's own folder, so the dance stays whole when copied. Written
  // under a temporary name and renamed into place, so a second copy of the same file (two clicks, or React running an effect
  // twice in development) always lands a complete file, never half of one.
  ipcMain.handle('dance:copy', async (_e, from: string, to: string) => {
    if (!writable(to)) throw new Error(`refused copy to ${to}`);
    if (!existsSync(from)) throw new Error(`no file to copy: ${from}`);
    await mkdir(dirname(to), { recursive: true });
    const temp = `${to}.copy-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await copyFile(from, temp);
    await rename(temp, to).catch(async (e: unknown) => {
      await rm(temp, { force: true });
      throw e;
    });
    return to;
  });
  ipcMain.handle('dance:bake', async (_e, request: BakeRequest) => {
    const result = await bakeDance(request, (line) => win?.webContents.send('dance:progress', line));
    appLog('dance bake', { vmd: request.vmd, name: request.name, ...result });
    return result;
  });
  // The window saves first and reloads after a move (its open skin and paths name the old folder).
  ipcMain.handle('data:move', async (_e, to: string) => {
    if (edition === 'dev') return { ok: false, reason: 'dev' };
    moving = true;
    try {
      await backend.stop();
      watchFiles([]); // a watched folder cannot be deleted
      const r = await moveData(to, true).catch((e: Error) => ({ ok: false as const, reason: 'failed' as const, detail: e.message }));
      appLog('data folder', { to, ...r });
      dialogDirs = null;
      return r;
    } finally {
      moving = false;
      startBackend();
    }
  });
  ipcMain.handle('dialog:open', async (_e, kind: 'folder' | 'files' | 'file', filters?: OpenDialogOptions['filters'], purpose?: string) => {
    const key = dialogKey(purpose ?? kind, filters);
    const paths = await pickPaths(kind, filters, lastDir(key));
    if (!paths.length) return [];
    remember(key, kind === 'folder' ? paths[0] : dirname(paths[0]));
    return paths;
  });
  ipcMain.handle('dialog:save', async (_e, defaultPath: string, filters: OpenDialogOptions['filters']) => {
    const key = dialogKey('save', filters);
    // A bare file name opens in the folder this kind of file was last saved to.
    const last = basename(defaultPath) === defaultPath ? lastDir(key) : undefined;
    const [path] = await pickPaths('save', filters, last ? join(last, defaultPath) : defaultPath);
    if (!path) return null;
    remember(key, dirname(path));
    return path;
  });
  ipcMain.handle('files:write', async (_e, path: string, data: Uint8Array) => {
    if (!writable(path)) throw new Error(`refused write outside frames/data dir: ${path}`);
    await mkdir(dirname(path), { recursive: true });
    // The same bytes again (a bake whose inputs did not change) leave the file and its write time alone, so the pack
    // build reuses what it made from it.
    if ((await readFile(path).catch(() => null))?.equals(data)) return;
    await writeFile(path, data);
  });
  // A text file the renderer may write (a bake's record), null when it is missing.
  ipcMain.handle('files:readText', async (_e, path: string) => {
    if (!writable(path)) throw new Error(`refused read outside frames/data dir: ${path}`);
    return readFile(path, 'utf8').catch(() => null);
  });
  // [size, write time in ms] of a file, null when it is not one: part of a bake's input key (renderer frames.ts bakeKey).
  ipcMain.handle('files:stat', async (_e, path: string) => {
    const s = await stat(path).catch(() => null);
    return s?.isFile() ? [s.size, s.mtimeMs] : null;
  });
  // The plain files of one folder — the dance tab lists its projects from the folder itself, so a project copied in
  // from outside (or one an older index forgot) still shows up.
  ipcMain.handle('files:list', (_e, dir: string) => {
    if (!isAbsolute(dir)) return [];
    const out: { name: string; time: number }[] = [];
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const s = statSync(join(dir, e.name), { throwIfNoEntry: false });
      out.push({ name: e.name, time: s?.mtimeMs ?? 0 });
    }
    return out;
  });
  ipcMain.on('app:log', (_e, kind: string, detail: string) => appLog(kind, detail));
  ipcMain.handle('files:exists', (_e, path: string) => existsSync(path));
  // Keeps a cache folder (the drawn pack pictures) under `limit` bytes: the least recently used files go first. Only allowed
  // inside the data dir, and only there.
  ipcMain.handle('files:prune', (_e, dir: string, limit: number) => {
    const p = isAbsolute(dir) ? normalize(dir) : '';
    if (!p.startsWith(resolve(dataDir()) + sep)) throw new Error(`refused prune outside the data dir: ${dir}`);
    if (!existsSync(p)) return 0;
    const infos = readdirSync(p, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const file = join(e.parentPath, e.name);
        return { file, size: statSync(file).size, time: statSync(file).mtimeMs };
      })
      .sort((a, b) => a.time - b.time);
    let total = infos.reduce((n, x) => n + x.size, 0);
    let freed = 0;
    for (const x of infos) {
      if (total <= limit) break;
      try {
        rmSync(x.file);
        total -= x.size;
        freed += x.size;
      } catch {
        // open: kept for the next prune
      }
    }
    return freed;
  });
  ipcMain.handle('files:watch', (_e, paths: string[]) => watchFiles(paths));
  ipcMain.handle('profile:watch', (_e, profile: string | null) => watchProfile(profile));
  // A folder opens in Explorer; a file is only shown in its folder, never launched.
  ipcMain.handle('shell:open', async (_e, path: string) => {
    if (isAbsolute(path) && (await stat(path).catch(() => null))?.isDirectory()) return shell.openPath(path);
    shell.showItemInFolder(path);
    return '';
  });
  ipcMain.handle('shell:show', (_e, path: string) => shell.showItemInFolder(path));
  ipcMain.on('win:minimize', () => win?.minimize());
  ipcMain.on('win:toggleMaximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.on('win:close', () => win?.close());
  ipcMain.handle('win:isMaximized', () => !!win?.isMaximized());
  // 检查更新: only reads the feed and says which version it holds; nothing is downloaded until the user asks for it
  // (update:download). A development run has no update feed.
  ipcMain.handle('update:check', async (): Promise<UpdateCheck> => {
    if (edition === 'dev') return { state: 'dev' };
    try {
      const { version } = await feedPackage();
      return newer(version, app.getVersion()) ? { state: edition === 'portable' ? 'portable' : 'available', version } : { state: 'latest' };
    } catch (e) {
      updateLog(`check failed: ${String(e)}`);
      return { state: 'error' };
    }
  });
  // The user chose to update: Squirrel checks the same feed, downloads the package and stages it for the next start.
  ipcMain.handle('update:download', () => {
    if (edition !== 'installed') return;
    autoUpdater.setFeedURL({ url: FEED });
    autoUpdater.checkForUpdates();
  });
  ipcMain.handle('app:version', () => app.getVersion());
}

const updateLog = (message: string) => appLog('update', message);
// Updates come from the GTFO-Forge-Mods repository: its release `ForgeSkin-update` always holds the newest installer's
// RELEASES and .nupkg (the repository has other packages' releases, so its "latest" is not ours).
const FEED = 'https://github.com/NAinfini/GTFO-Forge-Mods/releases/download/ForgeSkin-update';

/** What a check found: `available` (an installed copy can download `version`) and `portable` (a newer `version` exists,
 *  fetched by hand) carry the version. */
type UpdateCheck = { state: 'dev' | 'latest' | 'error' } | { state: 'available' | 'portable'; version: string };

/** The newest package in the feed: its file name, version and size, from the last line of RELEASES. */
async function feedPackage(): Promise<{ name: string; version: string; size: number }> {
  const r = await net.fetch(`${FEED}/RELEASES`);
  if (!r.ok) throw new Error(`RELEASES: HTTP ${r.status}`);
  const [, url, size] = (await r.text())
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .pop()!
    .split(' ');
  const name = decodeURIComponent(url.split('/').pop()!);
  const version = /-(\d+(?:\.\d+)*)-full\.nupkg$/i.exec(name)?.[1];
  if (!version) throw new Error(`RELEASES: no version in ${name}`);
  return { name, version, size: Number(size) || 0 };
}
/** True when version `a` is above `b`, part by part. */
function newer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

// The download takes minutes and Squirrel reports no progress: the window shows a bar from the package's size in the
// feed's RELEASES and the size of the file Update.exe is writing into <install>/packages/. Unknown sizes show a moving bar.
let watching = false;
async function watchDownload() {
  if (watching) return;
  watching = true;
  let file: string | null = null;
  let total = 0;
  try {
    const found = await feedPackage();
    file = join(dirname(process.execPath), '..', 'packages', found.name);
    total = found.size;
  } catch (e) {
    updateLog(`progress: no package size: ${String(e)}`);
  }
  const tick = () => {
    let received = 0;
    try {
      if (file) received = statSync(file).size;
    } catch {
      // not started yet
    }
    send('update:progress', received, total);
  };
  tick();
  const timer = setInterval(tick, 1000);
  const stop = (done: boolean) => () => {
    clearInterval(timer);
    watching = false;
    send('update:progress', done ? total || 1 : -1, total || 1);
  };
  autoUpdater.once('update-downloaded', stop(true));
  autoUpdater.once('error', stop(false));
}

// Every file the editor asks for comes through pickPaths: the system's dialog, with the file types and, for 'files', several
// at once. An empty answer is a cancel.
type PathKind = 'folder' | 'files' | 'file' | 'save';
type FileFilters = OpenDialogOptions['filters'];

async function pickPaths(kind: PathKind, filters: FileFilters, start: string | undefined): Promise<string[]> {
  if (kind === 'save') {
    const r = await dialog.showSaveDialog(win!, { defaultPath: start, filters });
    return r.canceled || !r.filePath ? [] : [r.filePath];
  }
  const properties: OpenDialogOptions['properties'] = kind === 'folder' ? ['openDirectory'] : kind === 'files' ? ['openFile', 'multiSelections'] : ['openFile'];
  const r = await dialog.showOpenDialog(win!, { properties, filters, defaultPath: start });
  return r.canceled ? [] : r.filePaths;
}
// Every file dialog opens where the last one of its kind was confirmed (a purpose, else the kind and file types), kept
// across runs in <dataDir>/dialogs.json.
const dialogsFile = () => join(dataDir(), 'dialogs.json');
let dialogDirs: Record<string, string> | null = null;
const dialogKey = (purpose: string, filters?: OpenDialogOptions['filters']) => [purpose, ...(filters ?? []).flatMap((f) => f.extensions)].join(':');
function lastDir(key: string): string | undefined {
  if (!dialogDirs) {
    try {
      dialogDirs = JSON.parse(readFileSync(dialogsFile(), 'utf8')) as Record<string, string>;
    } catch {
      dialogDirs = {};
    }
  }
  const dir = dialogDirs[key];
  return dir && existsSync(dir) ? dir : undefined;
}
function remember(key: string, dir: string) {
  lastDir(key);
  dialogDirs![key] = dir;
  try {
    writeFileSync(dialogsFile(), JSON.stringify(dialogDirs, null, 2));
  } catch (e) {
    appLog('dialogs', e);
  }
}

// The files the open skin uses, watched through their folders (an editor saving a file often replaces it, which a watch on
// the file itself loses). A changed file is reported once its writes have been quiet for 400 ms.
const watched = new Map<string, { watcher: FSWatcher; names: Set<string> }>();
const changed = new Set<string>();
let changedTimer: NodeJS.Timeout | undefined;
function watchFiles(paths: string[]) {
  const want = new Map<string, Set<string>>();
  for (const p of paths) {
    const dir = dirname(p);
    if (!want.has(dir)) want.set(dir, new Set());
    want.get(dir)!.add(basename(p).toLowerCase());
  }
  for (const [dir, w] of watched)
    if (!want.has(dir)) {
      w.watcher.close();
      watched.delete(dir);
    }
  for (const [dir, names] of want) {
    const w = watched.get(dir);
    if (w) {
      w.names = names;
      continue;
    }
    try {
      const entry = { names, watcher: watch(dir) };
      entry.watcher.on('change', (_type, name) => {
        if (!name || !entry.names.has(String(name).toLowerCase())) return;
        changed.add(join(dir, String(name)));
        clearTimeout(changedTimer);
        changedTimer = setTimeout(() => {
          send('files:changed', [...changed]);
          changed.clear();
        }, 400);
      });
      entry.watcher.on('error', () => (entry.watcher.close(), watched.delete(dir)));
      watched.set(dir, entry);
    } catch (e) {
      appLog('watch', e); // a folder that is gone: nothing to watch
    }
  }
}

// The chosen game profile's skin state: its skins folder (packs, active.json, picks) and the plugin's choices in config/, watched
// so the window's lists follow a pack put in or taken out by hand, the game's picker, or another program. Reported once the
// writes have been quiet for 400 ms.
let profileWatchers: FSWatcher[] = [];
let profileTimer: NodeJS.Timeout | undefined;
function watchProfile(profile: string | null) {
  for (const w of profileWatchers) w.close();
  profileWatchers = [];
  if (!profile) return;
  const folders: [string, (name: string) => boolean][] = [
    [join(profile, 'BepInEx', 'ForgeSkin', 'skins'), () => true],
    [join(profile, 'BepInEx', 'config'), (name) => /^ForgeSkin\.choices\.json$/i.test(name)],
  ];
  for (const [dir, counts] of folders) {
    if (!existsSync(dir)) continue; // made by the first install, which watches again
    try {
      const w = watch(dir, (_type, name) => {
        if (name && !counts(String(name))) return;
        clearTimeout(profileTimer);
        profileTimer = setTimeout(() => send('profile:changed'), 400);
      });
      w.on('error', () => w.close());
      profileWatchers.push(w);
    } catch (e) {
      appLog('watch', e); // a profile without BepInEx: nothing to follow
    }
  }
}

/** What the media element needs from us: a type, a length, and byte ranges (see `serve`). */
const MEDIA: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

/**
 * One file from `sf://local/`. Media is served with byte ranges: an `<audio>` seeks by asking for a range, and a plain
 * 200 answer to that leaves it unable to jump past what it has buffered — Chromium then drops the seek and carries on
 * from where it was, which read as the playhead snapping back when the scrubber was dragged.
 */
function serve(path: string, range: string | null): Response | null {
  const type = MEDIA[extname(path).toLowerCase()];
  // Everything else (pictures, the model) is fetched the usual way.
  if (!range && !type) return null;
  const size = statSync(path).size;
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
  if (type) headers.set('Content-Type', type);
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) {
    headers.set('Content-Length', String(size));
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers });
  }
  const tail = m[1] === '';
  const start = tail ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = tail || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: new Headers({ 'Content-Range': `bytes */${size}` }) });
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, { status: 206, headers });
}

app.whenReady().then(async () => {
  // Before anything writes into the data folder.
  if (!squirrelRun) await moveInstallData((line) => appLog('data folder', line));
  protocol.handle('sf', async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (!isAbsolute(path) || !SERVED.test(path)) return new Response(null, { status: 403 });
    const ranged = serve(path, req.headers.get('range'));
    if (ranged) return ranged;
    const r = await net.fetch(pathToFileURL(path).toString(), { headers: req.headers });
    const headers = new Headers(r.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  });
  registerIpc();
  startBackend();
  createWindow();
  // Nothing updates on its own: the window asks which version the feed holds when it starts (update:check) and offers it;
  // only the user's click downloads it (update:download), and the window then offers the restart (update:ready,
  // update:restart). The bundled plugin updates with it.
  ipcMain.handle('update:restart', () => autoUpdater.quitAndInstall());
  autoUpdater.on('update-available', () => void watchDownload());
  autoUpdater.on('update-downloaded', () => send('update:ready'));
  autoUpdater.on('error', (e) => updateLog(`update failed: ${e.message}`));
});

app.on('before-quit', () => {
  quitting = true;
  backend.stop();
});
app.on('window-all-closed', () => app.quit());
