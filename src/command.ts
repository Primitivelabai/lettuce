import { existsSync } from 'node:fs';
import path from 'node:path';

export interface SpawnPlan {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  exists?: (file: string) => boolean;
}

/**
 * Works out how to start the wrapped server. On Windows, commands like `npx` are
 * really `npx.cmd`, which Node can't start directly, so they're resolved here.
 * Everywhere else the command runs as written.
 */
export function planSpawn(command: string, args: string[], opts: ResolveOptions = {}): SpawnPlan {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { command, args };

  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const execPath = opts.execPath ?? process.execPath;
  const win = path.win32;

  // npm and npx ship with Node: run their JS entry point with this same node.
  const bare = win
    .basename(command)
    .toLowerCase()
    .replace(/\.(cmd|bat)$/, '');
  if (bare === 'npx' || bare === 'npm') {
    const cli = win.join(win.dirname(execPath), 'node_modules', 'npm', 'bin', `${bare}-cli.js`);
    if (exists(cli)) return { command: execPath, args: [cli, ...args] };
  }

  const resolved = findOnPath(command, env, exists);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return { command: resolved ?? command, args };

  // Batch files need cmd.exe. Quote and escape every part so nothing is read as shell syntax.
  const line = [escapeCommand(resolved), ...args.map(escapeArgument)].join(' ');
  return {
    command: env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean,
): string | undefined {
  const win = path.win32;
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = win.extname(command) !== '';
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e.toLowerCase()));

  if (command.includes('/') || command.includes('\\')) {
    return candidates(command).find(exists);
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    const hit = candidates(win.join(dir, command)).find(exists);
    if (hit) return hit;
  }
  return undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(cmd: string): string {
  return cmd.replace(CMD_META, '^$1');
}

function escapeArgument(arg: string): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`;
  // Escaped twice: once for cmd's own parsing and once for the .cmd file's re-parse.
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}
