import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  linkSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { ReceiptEntry } from './types.js';

const GENESIS_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const LOCK_HALF_WRITTEN_MS = 2_000;
const LOCK_WAIT_MS = 10_000;

export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj) ?? 'null';
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(',')}]`;
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads the last complete line of a file without loading all of it. */
function readLastLine(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    let chunkSize = 4096;
    while (true) {
      const start = Math.max(0, size - chunkSize);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim());
      if (lines.length > 1 || start === 0) return lines.at(-1) ?? null;
      chunkSize *= 4;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Append-only receipts, each holding the hash of the one before.
 *
 * Several wrapped servers can write to the same file, so every write takes a
 * short lock and reads the current last entry first. That keeps one unbroken
 * chain however many servers are running.
 */
export class ReceiptLedger {
  private readonly lockPath: string;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.lockPath = `${filePath}.lock`;
  }

  /**
   * Cross-process lock: a file holding the owner's pid and a random token. A lock
   * is only taken over when its owner process has died, never from a live writer,
   * however slow it is.
   */
  private withLock<T>(fn: () => T): T {
    const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        writeSync(fd, token);
        closeSync(fd);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // On Windows a lock file that another process is deleting gives EPERM: still locked.
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
        if (code === 'EEXIST') this.clearIfOwnerDead();
        if (Date.now() > deadline)
          throw new Error(`Receipts are locked by another process: ${this.lockPath}`);
        sleep(10);
      }
    }
    try {
      return fn();
    } finally {
      try {
        if (readFileSync(this.lockPath, 'utf8') === token) unlinkSync(this.lockPath);
      } catch {
        /* already gone */
      }
    }
  }

  private clearIfOwnerDead(): void {
    let content: string;
    let ageMs: number;
    try {
      content = readFileSync(this.lockPath, 'utf8');
      ageMs = Date.now() - statSync(this.lockPath).mtimeMs;
    } catch {
      return; // released meanwhile
    }
    const pid = Number(content.split(':')[0]);
    const ownerGone =
      Number.isSafeInteger(pid) && pid > 0 ? !processAlive(pid) : ageMs > LOCK_HALF_WRITTEN_MS;
    if (!ownerGone) return;

    // Move the lock aside in one atomic step, then look at what we actually moved.
    // If a live writer took the lock in the meantime, put it back with link(),
    // which fails rather than overwrite a newer lock.
    const aside = `${this.lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(this.lockPath, aside);
    } catch {
      return; // someone else moved or released it
    }
    try {
      if (readFileSync(aside, 'utf8') !== content) {
        try {
          linkSync(aside, this.lockPath);
        } catch {
          /* a newer lock exists; its owner holds it */
        }
      }
    } finally {
      try {
        unlinkSync(aside);
      } catch {
        /* already gone */
      }
    }
  }

  public record(
    entry: Omit<ReceiptEntry, 'seq' | 'ts' | 'prev_hash' | 'hash' | 'args_hash'> & { args: unknown },
  ): ReceiptEntry {
    return this.withLock(() => {
      const last = readLastLine(this.filePath);
      const tail = last ? (JSON.parse(last) as ReceiptEntry) : null;
      const { args, ...rest } = entry;

      const unsigned = {
        seq: (tail?.seq ?? 0) + 1,
        ts: new Date().toISOString(),
        ...rest,
        args_hash: sha256Hex(canonicalJson(args ?? {})),
        prev_hash: tail?.hash ?? GENESIS_HASH,
      };
      const signed: ReceiptEntry = { ...unsigned, hash: sha256Hex(canonicalJson(unsigned)) };
      appendFileSync(this.filePath, `${JSON.stringify(signed)}\n`, 'utf8');
      return signed;
    });
  }

  public static verifyChain(
    filePath: string,
    expectHash?: string,
  ): {
    valid: boolean;
    count: number;
    lastHash?: string;
    brokenAtSeq?: number;
    reason?: string;
  } {
    const missing = {
      valid: false,
      count: 0,
      reason: `the saved hash ${expectHash} is gone (file missing or empty)`,
    };
    if (!existsSync(filePath)) return expectHash ? missing : { valid: true, count: 0 };
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return expectHash ? missing : { valid: true, count: 0 };

    const lines = raw.split('\n');
    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;
    let seenExpected = false;

    for (const line of lines) {
      let entry: ReceiptEntry;
      try {
        entry = JSON.parse(line) as ReceiptEntry;
      } catch {
        return {
          valid: false,
          count: lines.length,
          brokenAtSeq: expectedSeq,
          reason: `entry ${expectedSeq} is not valid JSON`,
        };
      }
      if (entry.seq !== expectedSeq) {
        return {
          valid: false,
          count: lines.length,
          brokenAtSeq: entry.seq,
          reason: `expected entry ${expectedSeq}, found ${entry.seq}`,
        };
      }
      if (entry.prev_hash !== expectedPrev) {
        return {
          valid: false,
          count: lines.length,
          brokenAtSeq: entry.seq,
          reason: `entry ${entry.seq} doesn't follow the one before it`,
        };
      }
      const { hash, ...unsigned } = entry;
      if (sha256Hex(canonicalJson(unsigned)) !== hash) {
        return {
          valid: false,
          count: lines.length,
          brokenAtSeq: entry.seq,
          reason: `entry ${entry.seq} was edited`,
        };
      }
      expectedPrev = hash;
      if (hash === expectHash) seenExpected = true;
      expectedSeq += 1;
    }

    if (expectHash && !seenExpected) {
      return {
        valid: false,
        count: lines.length,
        reason: `the saved hash ${expectHash} is no longer in the receipts, so entries were removed or rewritten`,
      };
    }
    return { valid: true, count: lines.length, lastHash: expectedPrev };
  }
}
