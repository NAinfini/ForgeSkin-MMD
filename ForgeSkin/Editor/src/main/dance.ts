import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The bake kit: the MMD reference model and the script that turns a VMD into the game's `.dance`.
 * A dance's 50 joints are solved by MMD's own rules (付与, leg IK, twist bones), and the script runs that in Blender
 * through mmd_tools — the same way the standalone bake pipeline made every dance that ships today, so a dance baked
 * here matches them exactly. */
export function danceKit(): string {
  return app.isPackaged ? join(process.resourcesPath, 'dance') : join(app.getAppPath(), 'resources', 'dance');
}

const BLENDER_PATHS = [
  'D:\\Steam\\steamapps\\common\\Blender\\blender.exe',
  'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe',
];

/** The newest Blender under a Steam or Program Files install, then any other version folder — the bake needs 4.2+. */
function scan(): string[] {
  const found: string[] = [];
  const steam = 'D:\\Steam\\steamapps\\common\\Blender';
  const programs = 'C:\\Program Files\\Blender Foundation';
  for (const [root, tail] of [
    [steam, 'blender.exe'],
    [programs, 'blender.exe'],
  ] as const) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const file = entry.isDirectory() ? join(root, entry.name, tail) : join(root, entry.name);
      if (entry.isFile() && entry.name === tail) found.push(join(root, entry.name));
      else if (entry.isDirectory() && existsSync(file)) found.push(file);
    }
  }
  return found.sort().reverse();
}

export function findBlender(preferred?: string): string | null {
  if (preferred && existsSync(preferred)) return preferred;
  for (const file of [...BLENDER_PATHS, ...scan()]) if (existsSync(file)) return file;
  return null;
}

export type BakeRequest = { vmd: string; out: string; name: string; blender?: string };
export type BakeResult = { ok: true; blender: string } | { ok: false; reason: 'blender' | 'failed' | 'busy'; detail?: string };

let baking: Promise<BakeResult> | null = null;

/** Bakes one VMD into a `.dance`. One at a time: Blender is a whole application, and two would fight over the log. */
export function bakeDance(request: BakeRequest, onLine: (line: string) => void): Promise<BakeResult> {
  if (baking) return Promise.resolve({ ok: false, reason: 'busy' });
  const run = bakeNow(request, onLine).finally(() => (baking = null));
  baking = run;
  return run;
}

function bakeNow(request: BakeRequest, onLine: (line: string) => void): Promise<BakeResult> {
  const blender = findBlender(request.blender);
  if (!blender) return Promise.resolve({ ok: false, reason: 'blender' });
  const kit = danceKit();
  const args = [
    '-b',
    '--python',
    join(kit, 'blender_bake_vmd.py'),
    '--',
    join(kit, 'reference.pmx'),
    request.vmd,
    join(kit, 'model.json'),
    join(kit, 'manifest.json'),
    join(kit, 'canonical.json'),
    request.out,
    request.name,
  ];
  return new Promise((done) => {
    const child = spawn(blender, args, { windowsHide: true, cwd: kit });
    let last = '';
    const read = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const text = line.replace(/\r$/, '');
        if (!text.trim()) continue;
        last = text;
        onLine(text);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', (error) => done({ ok: false, reason: 'failed', detail: error.message }));
    child.once('close', (code) => {
      const made = existsSync(request.out) ? statSync(request.out).size : 0;
      if (code === 0 && made > 1024) return done({ ok: true, blender });
      done({ ok: false, reason: 'failed', detail: last || `Blender exited with code ${code} and wrote ${made} bytes` });
    });
  });
}

/** Blender's version line, for the settings panel: "" when there is none where we look. */
export function blenderVersion(file: string): Promise<string> {
  return new Promise((done) =>
    execFile(file, ['--version'], { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
      done(error ? '' : (stdout.split('\n')[0] ?? '').trim());
    }),
  );
}