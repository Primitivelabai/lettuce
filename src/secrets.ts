import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { secretsDir } from './paths.js';

const KEYCHAIN_PREFIX = 'keychain://';
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function assertSafeName(kind: string, value: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new Error(`Invalid ${kind} "${value}": use letters, numbers, dot, dash or underscore.`);
  }
}

/**
 * The macOS `security` command reads this from stdin (`security -i`), so the
 * secret never appears in a process list. The value is hex-encoded (-X), which
 * avoids any quoting inside the command line.
 */
export function macAddCommand(service: string, account: string, value: string): string {
  assertSafeName('service', service);
  assertSafeName('account', account);
  const hex = Buffer.from(value, 'utf8').toString('hex');
  return `add-generic-password -U -s ${service} -a ${account} -X ${hex}\n`;
}

// Windows: encrypt with DPAPI for the current user. PowerShell reads the value
// from stdin, so it never appears in a process list.
const PS_PROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
  '$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Console]::Out.Write([Convert]::ToBase64String($e))';

const PS_UNPROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$e=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
  '$b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Console]::Out.Write([Convert]::ToBase64String($b))';

function powershell(script: string, input: string): string {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  ).trim();
}

function windowsSecretPath(service: string, account: string): string {
  return join(secretsDir(), `${service}.${account}.dpapi`);
}

export class SecretVault {
  public static setSecret(service: string, account: string, value: string): void {
    assertSafeName('service', service);
    assertSafeName('account', account);

    if (process.platform === 'darwin') {
      execFileSync('security', ['-i'], {
        input: macAddCommand(service, account, value),
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      return;
    }

    if (process.platform === 'linux') {
      execFileSync(
        'secret-tool',
        ['store', `--label=${service}:${account}`, 'service', service, 'account', account],
        { input: value, stdio: ['pipe', 'ignore', 'pipe'] },
      );
      return;
    }

    if (process.platform === 'win32') {
      // Base64 on stdin, so the console code page can't mangle non-ASCII characters.
      const blob = powershell(PS_PROTECT, Buffer.from(value, 'utf8').toString('base64'));
      mkdirSync(secretsDir(), { recursive: true });
      writeFileSync(windowsSecretPath(service, account), blob, { encoding: 'utf8', mode: 0o600 });
      return;
    }

    throw new Error(
      `No OS keychain support on ${process.platform}; pass the value through the environment instead.`,
    );
  }

  public static getSecret(service: string, account: string): string {
    assertSafeName('service', service);
    assertSafeName('account', account);

    if (process.platform === 'darwin') {
      return execFileSync('security', ['find-generic-password', '-w', '-s', service, '-a', account], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).replace(/\n$/, '');
    }

    if (process.platform === 'linux') {
      return execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }

    if (process.platform === 'win32') {
      const file = windowsSecretPath(service, account);
      if (!existsSync(file)) {
        throw new Error(`No saved secret "${account}". Save it with: lettuce secret set ${account}`);
      }
      const b64 = powershell(PS_UNPROTECT, readFileSync(file, 'utf8'));
      return Buffer.from(b64, 'base64').toString('utf8');
    }

    throw new Error(
      `No OS keychain support on ${process.platform}; pass the value through the environment instead.`,
    );
  }

  public static resolveEnvMap(secretRefs?: Record<string, string>): {
    env: Record<string, string>;
    secretValues: string[];
  } {
    const env: Record<string, string> = {};
    const secretValues: string[] = [];
    if (!secretRefs) return { env, secretValues };

    for (const [envKey, ref] of Object.entries(secretRefs)) {
      if (!ref.startsWith(KEYCHAIN_PREFIX)) {
        env[envKey] = ref;
        if (ref) secretValues.push(ref);
        continue;
      }

      const pathPart = ref.slice(KEYCHAIN_PREFIX.length);
      const slashIdx = pathPart.indexOf('/');
      if (slashIdx === -1) {
        throw new Error(`Invalid keychain address "${ref}". Expected keychain://<service>/<name>`);
      }

      const resolved = SecretVault.getSecret(pathPart.slice(0, slashIdx), pathPart.slice(slashIdx + 1));
      env[envKey] = resolved;
      if (resolved) secretValues.push(resolved);
    }

    return { env, secretValues };
  }

  /** Hides secret values in the wrapped server's stderr. Keeps a short tail so a secret split across chunks is still caught. */
  public static createRedactingTransform(secrets: string[]): Transform {
    // Hide each value as-is and as it looks inside a JSON string ("a\"b").
    const list = [
      ...new Set(secrets.filter(Boolean).flatMap((s) => [s, JSON.stringify(s).slice(1, -1)])),
    ].sort((a, b) => b.length - a.length);
    const keep = list.reduce((m, s) => Math.max(m, s.length), 0) - 1;
    let carry = '';
    const scrub = (text: string) => {
      for (const secret of list) text = text.split(secret).join('***hidden by lettuce***');
      return text;
    };
    return new Transform({
      transform(chunk, _encoding, callback) {
        const text = scrub(carry + chunk.toString('utf8'));
        if (keep <= 0) {
          carry = '';
          callback(null, text);
          return;
        }
        carry = text.slice(-keep);
        callback(null, text.slice(0, text.length - carry.length));
      },
      flush(callback) {
        callback(null, scrub(carry));
      },
    });
  }
}
