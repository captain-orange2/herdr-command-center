import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Last-run time per command id, in epoch ms. It only feeds the palette ranking,
// so a missing or corrupt file just means "nothing used yet" — never an error.
export async function loadUsage(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// Losing this file costs a ranking, not data, so a plain write is enough and a
// failed one must never stand between the user and the command they picked.
export async function recordUsage(file, usage, id, now = Date.now()) {
  const next = { ...usage, [id]: now };
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(next), 'utf8');
  } catch {
    // Ranking only.
  }
  return next;
}
