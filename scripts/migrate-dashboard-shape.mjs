// One-off, network-free migration that rewrites the already-generated dashboard
// JSON in public/data into the new shape expected by the redesigned UI:
//
//   * alerts surface only at the problem level (no promoted details)
//   * each alert / entity carries a rich `details` breakdown (name, actual,
//     expected, share, deltaPct, deviationSigma, direction, timeline) that drives
//     the in-place detail filter
//   * alerts carry `deviationSigma` + `baselineLabel` and drop the retired
//     priority / historic-rank / queue-logic fields
//   * district map cells carry a `hasData` flag so no-data boards stay neutral
//
// The canonical pipeline (scripts/build-dashboard.mjs) emits this shape directly
// from live data. This script exists so the checked-in sample data matches the new
// shape without a network refetch. Per-detail daily timelines are reconstructed by
// allocating the parent timeline across details by share — an approximation that is
// only used by this local sample; a real `npm run refresh:data` produces exact
// per-descriptor series.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT_ROOT = path.resolve('public/data')
const ALERT_ROOT = path.join(OUTPUT_ROOT, 'alerts')
const ENTITY_ROOT = path.join(OUTPUT_ROOT, 'entities')
const INDEX_PATH = path.join(OUTPUT_ROOT, 'dashboard-index.json')

function round1(value) {
  return Math.round(value * 10) / 10
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function baselineLabelForHorizon(horizon) {
  switch (horizon) {
    case 'today':
      return 'vs a typical day'
    case '7d':
      return 'vs prior weeks'
    case '30d':
      return 'vs prior 30-day windows'
    case 'quarter':
      return 'vs the same quarter in prior years'
    default:
      return 'vs the same period in prior years'
  }
}

function median(values) {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// A robust z-score of `value` against `history`, mirroring robustScore() in the
// canonical pipeline: deviation from the median in units of the MAD-based scale.
function robustZ(value, history) {
  if (history.length < 8) {
    return 0
  }
  const center = median(history)
  const scale = median(history.map((entry) => Math.abs(entry - center))) * 1.4826
  if (scale < 1e-6) {
    return 0
  }
  return (value - center) / scale
}

function horizonWindowDays(horizon) {
  switch (horizon) {
    case 'today':
      return 1
    case '7d':
      return 7
    case '30d':
      return 30
    case 'quarter':
      return 90
    default:
      return 365
  }
}

// Standardize the trailing window total against the distribution of equivalent
// trailing-window totals across the series' history. This is the displayed
// "standard deviations above/below the baseline" figure — comparison-aware and on
// a sane human scale, unlike a raw Poisson residual on yearly totals.
function timelineSigma(timeline, horizon, direction) {
  const windowDays = horizonWindowDays(horizon)
  const actuals = (timeline ?? []).map((point) => point.actual)

  if (actuals.length <= windowDays + 8) {
    return 0
  }

  const windowTotals = []
  for (let end = windowDays; end <= actuals.length; end += 1) {
    let sum = 0
    for (let index = end - windowDays; index < end; index += 1) {
      sum += actuals[index]
    }
    windowTotals.push(sum)
  }

  const latest = windowTotals.at(-1)
  const history = windowTotals.slice(0, -1)
  const sigma = robustZ(latest, history)
  const magnitude = Math.min(Math.abs(sigma), 99)
  return round1(direction === 'down' ? -magnitude : magnitude)
}

// Reconstruct a per-detail daily timeline by allocating the parent timeline across
// the detail's share of recent volume. Tail actual/expected are pinned to the
// detail's known horizon totals so the filtered chart and metric strip agree.
function synthDetailTimeline(parentTimeline, detail, horizon) {
  const windowDays = horizonWindowDays(horizon)
  const tail = parentTimeline.slice(-windowDays)
  const parentActual = tail.reduce((sum, point) => sum + point.actual, 0) || 1
  const parentExpected = tail.reduce((sum, point) => sum + point.expected, 0) || 1
  const actualScale = detail.actual / parentActual
  const expectedScale = detail.expected / Math.max(1, parentExpected)

  return parentTimeline.map((point) => ({
    actual: Math.max(0, round1(point.actual * actualScale)),
    date: point.date,
    expected: Math.max(0, round2(point.expected * expectedScale)),
  }))
}

function toDetail(contributor, parentTimeline, parentSigma, parentDeltaPct, horizon, direction) {
  const actual = contributor.actual
  const expected = contributor.expected
  const deltaPct = expected > 0 ? round1(((actual - expected) / expected) * 100) : 0
  const timeline = synthDetailTimeline(parentTimeline, { actual, expected }, horizon)
  // Scale the parent's sigma by how this detail's relative deviation compares with
  // the parent's, so heavier-deviating descriptors read as more standard deviations
  // out. (The canonical pipeline refits each descriptor's own series for an exact
  // figure; this keeps the sample's badges differentiated and plausible.)
  const ratio = Math.abs(parentDeltaPct) > 1 ? deltaPct / parentDeltaPct : 1
  const sigma = Math.min(99, Math.abs(parentSigma) * Math.max(0.2, Math.min(3, ratio)))

  return {
    actual,
    baselineLabel: baselineLabelForHorizon(horizon),
    deltaPct,
    deviationSigma: round1(direction === 'down' ? -sigma : sigma),
    direction,
    expected,
    name: contributor.name,
    share: contributor.share,
    timeline,
  }
}

function migrateMapCells(map) {
  return map.map((cell) => {
    const hasData = cell.actual > 0 || cell.expected > 0
    return {
      ...cell,
      hasData,
    }
  })
}

function migrateAlert(alert) {
  const direction = alert.direction ?? 'up'
  const sigma = timelineSigma(alert.timeline ?? [], alert.horizon, direction)
  const details = (alert.contributors ?? []).map((contributor) =>
    toDetail(contributor, alert.timeline ?? [], sigma, alert.deltaPct, alert.horizon, direction),
  )

  const next = {
    actual: alert.actual,
    artifacts: alert.artifacts ?? [],
    baselineLabel: baselineLabelForHorizon(alert.horizon),
    comparabilityStart: alert.comparabilityStart,
    deltaPct: alert.deltaPct,
    detail: alert.detail,
    details,
    deviationSigma: sigma,
    direction,
    expected: alert.expected,
    geography: alert.geography,
    historyTimeline: alert.historyTimeline ?? [],
    horizon: alert.horizon,
    horizonScores: alert.horizonScores,
    id: alert.id,
    map: migrateMapCells(alert.map ?? []),
    problem: alert.problem,
    secondarySignals: alert.secondarySignals ?? [],
    sparkline: alert.sparkline ?? [],
    summary: alert.summary,
    surfaceLevel: alert.surfaceLevel,
    tags: (alert.tags ?? []).filter((tag) => tag !== 'Problem detail'),
    timeline: alert.timeline ?? [],
    title: alert.title,
  }

  return next
}

function migrateAlertSummary(alert, sigmaById) {
  return {
    actual: alert.actual,
    artifacts: alert.artifacts ?? [],
    baselineLabel: baselineLabelForHorizon(alert.horizon),
    deltaPct: alert.deltaPct,
    detail: alert.detail,
    deviationSigma: sigmaById.get(alert.id) ?? 0,
    direction: alert.direction ?? 'up',
    expected: alert.expected,
    geography: alert.geography,
    horizon: alert.horizon,
    horizonScores: alert.horizonScores,
    id: alert.id,
    problem: alert.problem,
    sparkline: alert.sparkline ?? [],
    summary: alert.summary,
    surfaceLevel: alert.surfaceLevel,
    title: alert.title,
  }
}

function migrateEntity(entity) {
  const direction = 'up'
  const sigma = timelineSigma(entity.timeline ?? [], entity.defaultHorizon, direction)
  const parentDeltaPct = (entity.contributors ?? [])[0]?.expected > 0
    ? ((entity.contributors[0].actual - entity.contributors[0].expected) / entity.contributors[0].expected) * 100
    : 100
  const details = (entity.contributors ?? []).map((contributor) =>
    toDetail(contributor, entity.timeline ?? [], sigma, parentDeltaPct, entity.defaultHorizon, direction),
  )

  const { contributors, ...rest } = entity
  return {
    ...rest,
    details,
    map: migrateMapCells(entity.map ?? []),
  }
}

async function migrateDir(dir, migrateFn, onMigrated) {
  const files = await readdir(dir)
  let count = 0

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue
    }

    const filePath = path.join(dir, file)
    const record = JSON.parse(await readFile(filePath, 'utf8'))
    const migrated = migrateFn(record)
    await writeFile(filePath, JSON.stringify(migrated))
    onMigrated?.(migrated)
    count += 1
  }

  return count
}

async function main() {
  // Migrate the detail files first so we can carry each alert's computed sigma
  // back into the lightweight index summaries (which have no timeline of their own).
  const sigmaById = new Map()
  const alertCount = await migrateDir(ALERT_ROOT, migrateAlert, (alert) => {
    sigmaById.set(alert.id, alert.deviationSigma)
  })
  const entityCount = await migrateDir(ENTITY_ROOT, migrateEntity)

  const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'))

  index.allAlerts = (index.allAlerts ?? []).map((alert) => migrateAlertSummary(alert, sigmaById))
  index.mainQueue = (index.mainQueue ?? []).map((alert) => migrateAlertSummary(alert, sigmaById))
  index.fixedHorizon = Object.fromEntries(
    Object.entries(index.fixedHorizon ?? {}).map(([horizon, alerts]) => [
      horizon,
      alerts.map((alert) => migrateAlertSummary(alert, sigmaById)),
    ]),
  )
  index.entities = (index.entities ?? []).map((entity) => {
    const { contributors, ...rest } = entity
    return rest
  })

  await writeFile(INDEX_PATH, JSON.stringify(index))

  console.log(`Migrated ${alertCount} alerts, ${entityCount} entities, and index to the new shape`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
