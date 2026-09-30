import { open, link, rename, lstat, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const MAX_BYTES = 4194304;
const identity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (a, b) => a !== null && a.dev === b.dev && a.ino === b.ino;

/** Receives only the coordinator's already closed-validated, serialized snapshot. */
export async function publishSnapshot(destination, sequence, text, previous, notifyOwned = () => {}, testFault = null) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) return { ok: false, category: 'SNAPSHOT_INVALID' };
  const temporary = `${destination}.tmp-${sequence}`;
  let owned = null;
  let handle = null;
  let category = 'WRITE_FAILED';
  let result;
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { ok: false, category: 'SIZE_LIMIT' };
    const parsed = JSON.parse(text);
    if (parsed.schemaVersion !== 'P18B_PRIVATE_STREAM_DIAGNOSTICS_V1' || parsed.snapshot.sequence !== sequence || parsed.grantsAuthority !== false || parsed.provesAccountContinuity !== false) return { ok: false, category: 'SNAPSHOT_INVALID' };
    category = 'OPEN_FAILED';
    await mkdir(path.dirname(destination), { recursive: true });
    handle = await open(temporary, 'wx', 0o600);
    owned = identity(await handle.stat({ bigint: true }));
    notifyOwned(owned);
    category = 'WRITE_FAILED';
    if (testFault === 'AFTER_OPEN') throw new Error('TEST_FAULT');
    await handle.writeFile(text, 'utf8');
    if (testFault === 'AFTER_WRITE') throw new Error('TEST_FAULT');
    await handle.close(); handle = null;
    if (testFault === 'HANG_AFTER_CLOSE') await new Promise(() => {});
    if (previous === null) {
      category = 'WRITE_FAILED';
      if (testFault === 'BEFORE_LINK') throw new Error('TEST_FAULT');
      try { await link(temporary, destination); }
      catch (error) { category = error?.code === 'EEXIST' ? 'DESTINATION_EXISTS' : 'WRITE_FAILED'; throw new Error('PUBLICATION_FAILED'); }
    } else {
      category = 'OWNERSHIP_LOST';
      const current = await lstat(destination, { bigint: true });
      if (!current.isFile() || !same(previous, identity(current))) throw new Error('OWNERSHIP_LOST');
      category = 'REPLACE_FAILED';
      if (testFault === 'BEFORE_REPLACE') throw new Error('TEST_FAULT');
      await rename(temporary, destination);
    }
    result = { ok: true, ownership: owned };
  } catch { result = { ok: false, category }; }
  finally {
    if (handle !== null) { try { await handle.close(); } catch { /* Own handle only. */ } }
    if (owned !== null) {
      try {
        const stat = await lstat(temporary, { bigint: true });
        if (!stat.isFile() || !same(owned, identity(stat))) result = { ok: false, category: 'TEMP_CLEANUP_FAILED' };
        else await unlink(temporary);
      } catch (error) { if (error?.code !== 'ENOENT') result = { ok: false, category: 'TEMP_CLEANUP_FAILED' }; }
    }
  }
  return result;
}

if (parentPort !== null && typeof workerData?.destination === 'string') {
  let ownership = null;
  let busy = false;
  parentPort.on('message', async (message) => {
    if (busy) return;
    busy = true;
    const result = await publishSnapshot(workerData.destination, message.sequence, message.text, ownership,
      (temporaryOwnership) => parentPort.postMessage({ kind: 'TEMP_OWNED', sequence: message.sequence, ownership: temporaryOwnership }), workerData.testFault ?? null);
    if (result.ok) ownership = result.ownership;
    parentPort.postMessage({ kind: 'RESULT', sequence: message.sequence, ...result });
    busy = false;
  });
}
