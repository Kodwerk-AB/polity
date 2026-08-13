import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A disk cache for every network read.
 *
 * The pipeline is ~200 countries x several requests each, over APIs that rate
 * limit hard and are slow when they do not. Without this, changing one line of
 * the extractor means re-paying the whole harvest — which is exactly the
 * friction that stops a dataset being iterated on.
 *
 * Keyed on the full URL, sharded two levels deep so a directory never holds
 * tens of thousands of entries. Values are stored as JSON with the fetch time
 * beside them so a TTL is possible without a second index.
 */

const CACHE_ROOT = join(process.cwd(), '.cache')

interface Entry<T> {
  fetched_at: string
  value: T
}

const pathFor = (key: string): string => {
  const hash = createHash('sha256').update(key).digest('hex')
  return join(CACHE_ROOT, hash.slice(0, 2), hash.slice(2, 4), `${hash.slice(4)}.json`)
}

export const cacheRead = <T>(key: string, maxAgeMs?: number): T | undefined => {
  const file = pathFor(key)
  if (!existsSync(file)) return undefined
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8')) as Entry<T>
    if (maxAgeMs !== undefined) {
      const age = Date.now() - new Date(entry.fetched_at).getTime()
      if (age > maxAgeMs) return undefined
    }
    return entry.value
  } catch {
    // A truncated file from an interrupted run is a miss, not a crash.
    return undefined
  }
}

export const cacheWrite = <T>(key: string, value: T): void => {
  const file = pathFor(key)
  mkdirSync(dirname(file), { recursive: true })
  const entry: Entry<T> = { fetched_at: new Date().toISOString(), value }
  writeFileSync(file, JSON.stringify(entry))
}

/** `sha256:…` over any string — the composition change-detection key. */
export const hashOf = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
