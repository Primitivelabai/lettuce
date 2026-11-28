import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { planSpawn } from '../src/command.js';

const node = 'C:\\Program Files\\nodejs\\node.exe';
const npxCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js';

describe('starting the wrapped server', () => {
  it('runs commands as written outside Windows', () => {
    const plan = planSpawn('npx', ['-y', 'pkg'], { platform: 'linux' });
    assert.deepEqual(plan, { command: 'npx', args: ['-y', 'pkg'] });
  });

  it('runs npx on Windows through node and npx-cli.js', () => {
    const plan = planSpawn('npx', ['-y', 'pkg'], {
      platform: 'win32',
      execPath: node,
      exists: (f) => f === npxCli,
    });
    assert.deepEqual(plan, { command: node, args: [npxCli, '-y', 'pkg'] });
  });

  it('resolves an .exe on PATH', () => {
    const plan = planSpawn('uvx', ['srv'], {
      platform: 'win32',
      env: { PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE;.CMD' },
      exists: (f) => f === 'C:\\b\\uvx.exe',
    });
    assert.deepEqual(plan, { command: 'C:\\b\\uvx.exe', args: ['srv'] });
  });

  it('runs a .cmd through cmd.exe with every argument quoted and escaped', () => {
    const plan = planSpawn('tool', ['a b', 'x&calc', '%PATH%'], {
      platform: 'win32',
      env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\cmd.exe' },
      exists: (f) => f === 'C:\\bin\\tool.cmd',
    });
    assert.equal(plan.command, 'C:\\Windows\\cmd.exe');
    assert.equal(plan.windowsVerbatimArguments, true);
    const line = plan.args[3]!;
    assert.ok(!/[^^]&/.test(line), 'every & is escaped');
    assert.ok(!/[^^]%/.test(line), 'every % is escaped');
  });

  it('starts real npm on Windows', { skip: process.platform !== 'win32' }, () => {
    const plan = planSpawn('npm', ['--version']);
    const out = spawnSync(plan.command, plan.args, {
      encoding: 'utf8',
      windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false,
    });
    assert.match(out.stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});
