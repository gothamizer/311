import { readFile } from 'node:fs/promises'
import path from 'node:path'

const DATA_ROOT = path.resolve('public/data')
const INDEX_PATH = path.join(DATA_ROOT, 'dashboard-index.json')

const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'))
const alertIds = new Set(index.allAlerts.map((alert) => alert.id))
const alertedProblems = new Set(index.allAlerts.map((alert) => alert.problem))

for (const alert of index.allAlerts) {
  if (alert.surfaceLevel !== 'problem') {
    throw new Error(`Alert ${alert.id} has non-problem surfaceLevel: ${alert.surfaceLevel}`)
  }

  for (const field of ['baselineLabel', 'deviationSigma']) {
    if (alert[field] === undefined) {
      throw new Error(`Alert ${alert.id} is missing ${field}`)
    }
  }

  await readJson(path.join(DATA_ROOT, 'alerts', `${alert.id}.json`))
}

for (const entity of index.entities) {
  const record = await readJson(path.join(DATA_ROOT, 'entities', `${entityFileSlug(entity.id)}.json`))

  // An active descriptor should link to a parent-problem alert — but only when one
  // exists. A descriptor can be anomalous on its own while the aggregated problem
  // never clears the alert bar (its descriptors cancel out, or the problem-level
  // baseline isn't breached). In that legitimate case there is simply no alert to
  // point at, and the UI just omits the jump-to-alert affordance.
  if (
    record.currentStatus === 'active' &&
    record.type === 'detail' &&
    !record.topAlertId &&
    alertedProblems.has(record.parentProblem)
  ) {
    throw new Error(
      `Active detail entity ${record.id} has no topAlertId despite ${record.parentProblem} having alerts`,
    )
  }

  if (record.topAlertId && !alertIds.has(record.topAlertId)) {
    throw new Error(`Entity ${record.id} points at missing topAlertId ${record.topAlertId}`)
  }

  if (!Array.isArray(record.map) || record.map.some((cell) => typeof cell.hasData !== 'boolean')) {
    throw new Error(`Entity ${record.id} has map cells without hasData`)
  }
}

console.log(`Validated ${index.allAlerts.length} alerts and ${index.entities.length} entities`)

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Failed to read ${filePath}: ${error.message}`)
  }
}

function entityFileSlug(value) {
  return `${slugify(value)}-${hashString(value)}`
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120)
}

function hashString(value) {
  let hash = 2_166_136_261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }

  return (hash >>> 0).toString(36)
}
