import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DATASET_ID = 'phws-rnrn'
const SOCRATA_BASE_URL = `https://data.cityofnewyork.us/resource/${DATASET_ID}.json`
const OUTPUT_ROOT = path.resolve('public/data')
const ALERT_OUTPUT_ROOT = path.join(OUTPUT_ROOT, 'alerts')
const ENTITY_OUTPUT_ROOT = path.join(OUTPUT_ROOT, 'entities')
const INDEX_OUTPUT_PATH = path.join(OUTPUT_ROOT, 'dashboard-index.json')
const WINDOW_DAYS = Number(process.env.DASHBOARD_WINDOW_DAYS ?? 365 * 3)
const MAX_QUEUE = 25
const TOP_DETAIL_PROBLEM_COUNT = 15
const PAGE_LIMIT = process.env.DASHBOARD_PAGE_LIMIT ? Number(process.env.DASHBOARD_PAGE_LIMIT) : undefined
const PARTITION_MONTHS = Number(process.env.DASHBOARD_PARTITION_MONTHS ?? 3)
const HORIZON_MINIMUMS = {
  today: { deltaPct: 35, diff: 2, volume: 3 },
  '7d': { deltaPct: 20, diff: 6, volume: 12 },
  '30d': { deltaPct: 15, diff: 20, volume: 30 },
  quarter: { deltaPct: 10, diff: 40, volume: 60 },
  year: { deltaPct: 8, diff: 80, volume: 120 },
}
const HORIZONS = ['today', '7d', '30d', 'quarter', 'year']
const BOROUGH_META = [
  { boardCount: 12, codePrefix: '1', id: 'manhattan', label: 'Manhattan', shortLabel: 'Manhattan' },
  { boardCount: 12, codePrefix: '2', id: 'bronx', label: 'Bronx', shortLabel: 'Bronx' },
  { boardCount: 18, codePrefix: '3', id: 'brooklyn', label: 'Brooklyn', shortLabel: 'Brooklyn' },
  { boardCount: 14, codePrefix: '4', id: 'queens', label: 'Queens', shortLabel: 'Queens' },
  { boardCount: 3, codePrefix: '5', id: 'staten-island', label: 'Staten Island', shortLabel: 'Staten Island' },
]
const ARTIFACT_PENALTIES = {
  'Limited history': 10,
  'Panel-wide break': 20,
  'Possible taxonomy artifact': 15,
}
const BOROUGH_NAME_TO_ID = {
  BRONX: 'bronx',
  BROOKLYN: 'brooklyn',
  MANHATTAN: 'manhattan',
  QUEENS: 'queens',
  'STATEN ISLAND': 'staten-island',
}
const VALID_BOROUGHS = new Set(Object.keys(BOROUGH_NAME_TO_ID))
const CURRENT_DATE = new Date()
const END_DATE = startOfDay(addDays(CURRENT_DATE, -1))
const START_DATE = startOfDay(addDays(END_DATE, -(WINDOW_DAYS - 1)))
const DATE_KEYS = buildDateKeys(START_DATE, END_DATE)
const DATE_INDEX = new Map(DATE_KEYS.map((dateKey, index) => [dateKey, index]))
const BOARD_DEFINITIONS = buildBoardDefinitions()
const GEOGRAPHIES = buildGeographies()
const GEOGRAPHY_BY_ID = new Map(GEOGRAPHIES.map((geography) => [geography.id, geography]))

async function main() {
  console.log(`Building dashboard for ${formatDateKey(START_DATE)} to ${formatDateKey(END_DATE)}`)

  const topDetailProblems = await fetchTopDetailProblems()
  console.log(`Tracking detail series for ${topDetailProblems.length} high-volume problems`)

  const [
    citywideProblemRows,
    boroughProblemRows,
    boardProblemRows,
    citywideDetailRows,
    boroughDetailRows,
  ] = await Promise.all([
    fetchPartitionedAggregates({
      label: 'problem-citywide',
      extraWhere: '',
      group: ['day', 'complaint_type'],
      partitionMonths: PARTITION_MONTHS,
      select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'count(*) as n'],
      startDate: START_DATE,
    }),
    fetchPartitionedAggregates({
      label: 'problem-borough',
      extraWhere: `borough in (${quoteList(Object.keys(BOROUGH_NAME_TO_ID))})`,
      group: ['day', 'complaint_type', 'borough'],
      partitionMonths: PARTITION_MONTHS,
      select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'borough', 'count(*) as n'],
      startDate: START_DATE,
    }),
    fetchPartitionedAggregates({
      label: 'problem-board',
      extraWhere: 'community_board is not null',
      group: ['day', 'complaint_type', 'community_board'],
      partitionMonths: PARTITION_MONTHS,
      select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'community_board', 'count(*) as n'],
      startDate: START_DATE,
    }),
    fetchPartitionedAggregates({
      label: 'detail-citywide',
      extraWhere: `descriptor is not null AND complaint_type in (${quoteList(topDetailProblems)})`,
      group: ['day', 'complaint_type', 'descriptor'],
      partitionMonths: PARTITION_MONTHS,
      select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'descriptor', 'count(*) as n'],
      startDate: START_DATE,
    }),
    fetchPartitionedAggregates({
      label: 'detail-borough',
      extraWhere: `descriptor is not null AND borough in (${quoteList(Object.keys(BOROUGH_NAME_TO_ID))}) AND complaint_type in (${quoteList(topDetailProblems)})`,
      group: ['day', 'complaint_type', 'descriptor', 'borough'],
      partitionMonths: PARTITION_MONTHS,
      select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'descriptor', 'borough', 'count(*) as n'],
      startDate: START_DATE,
    }),
  ])

  const problemSeries = new Map()
  const detailSeries = new Map()

  ingestProblemRows(problemSeries, citywideProblemRows, 'citywide')
  ingestProblemRows(problemSeries, boroughProblemRows, 'borough')
  ingestProblemRows(problemSeries, boardProblemRows, 'community-board')
  ingestDetailRows(detailSeries, citywideDetailRows, 'citywide')
  ingestDetailRows(detailSeries, boroughDetailRows, 'borough')

  const problemEvaluations = evaluateSeriesCollection(problemSeries, {
    includeDetails: true,
    topDetailProblems: new Set(topDetailProblems),
  })
  const detailEvaluations = evaluateSeriesCollection(detailSeries, {
    includeDetails: false,
    topDetailProblems: new Set(topDetailProblems),
  })

  const panelWideBreak = detectPanelWideBreak(problemEvaluations)
  applyPanelWideBreak(problemEvaluations, panelWideBreak)
  applyPanelWideBreak(detailEvaluations, panelWideBreak)

  for (const evaluation of problemEvaluations) {
    finalizePriority(evaluation, problemEvaluations)
  }

  for (const evaluation of detailEvaluations) {
    finalizePriority(evaluation, problemEvaluations)
  }

  const detailIndex = buildDetailIndex(detailEvaluations)
  const detailBySeriesKey = new Map(detailEvaluations.map((evaluation) => [evaluation.seriesKey, evaluation]))

  const problemAlerts = selectProblemAlerts(problemEvaluations, detailIndex, detailBySeriesKey)
  const allAlerts = mergeGeographyDuplicates(problemAlerts).sort((left, right) => right.priority - left.priority)
  const alertRecords = allAlerts.map((evaluation) =>
    buildAlertRecord(evaluation, detailIndex, problemEvaluations),
  )

  const alertMap = new Map(alertRecords.map((alert) => [alert.id, alert]))
  const fixedHorizon = buildFixedHorizon(alertRecords)
  const mainQueue = alertRecords.slice(0, MAX_QUEUE)

  const entityIndex = buildEntityIndex(problemEvaluations, detailEvaluations, detailIndex, alertMap)

  await prepareOutputDirectories()
  await writeAlertFiles(alertRecords)
  await writeEntityFiles(entityIndex)

  const dashboardIndex = {
    allAlerts: alertRecords.map(toAlertSummary),
    entities: entityIndex.map(toEntitySummary),
    fixedHorizon: Object.fromEntries(
      Object.entries(fixedHorizon).map(([horizon, alerts]) => [horizon, alerts.map(toAlertSummary)]),
    ),
    generatedAt: new Date().toISOString(),
    lastRefresh: formatDateKey(END_DATE),
    mainQueue: mainQueue.map(toAlertSummary),
    metrics: {
      activeAlerts: alertRecords.length,
      boardAlerts: alertRecords.filter((alert) => alert.geography.type === 'community-board').length,
      citywideAlerts: alertRecords.filter((alert) => alert.geography.type === 'citywide').length,
      flaggedAlerts: alertRecords.filter((alert) => alert.artifacts.length > 0).length,
    },
  }

  await writeJson(INDEX_OUTPUT_PATH, dashboardIndex)

  console.log(`Wrote ${alertRecords.length} alerts and ${entityIndex.length} entities`)
}

function buildBaseWhere(startDate, endDateExclusive, extraWhere = '') {
  const clauses = [
    `created_date >= '${formatDateKey(startDate)}T00:00:00'`,
    `created_date < '${formatDateKey(endDateExclusive)}T00:00:00'`,
    'complaint_type is not null',
  ]

  if (extraWhere) {
    clauses.push(extraWhere)
  }

  return clauses.join(' AND ')
}

async function fetchTopDetailProblems() {
  const rows = await fetchAggregates({
    group: ['complaint_type'],
    label: 'top-detail-problems',
    select: ['complaint_type', 'count(*) as n'],
    where: `created_date >= '${formatDateKey(addDays(END_DATE, -364))}T00:00:00' AND created_date < '${formatDateKey(addDays(END_DATE, 1))}T00:00:00' AND complaint_type is not null`,
    order: 'n DESC',
    limit: TOP_DETAIL_PROBLEM_COUNT,
  })

  return rows
    .map((row) => row.complaint_type)
    .filter(Boolean)
}

async function fetchPartitionedAggregates({
  extraWhere,
  group,
  label,
  partitionMonths,
  select,
  startDate,
}) {
  const rows = []

  for (const partition of buildPartitions(startDate, END_DATE, partitionMonths)) {
    const partitionLabel = `${label}:${formatDateKey(partition.startDate)}`
    const partitionRows = await fetchAggregates({
      group,
      label: partitionLabel,
      select,
      where: buildBaseWhere(partition.startDate, partition.endExclusive, extraWhere),
    })

    for (const row of partitionRows) {
      rows.push(row)
    }
  }

  return rows
}

async function fetchAggregates({ group, label, limit, order, select, where }) {
  const pageSize = limit ?? 50_000
  const rows = []
  let offset = 0
  let pageCount = 0

  for (;;) {
    const params = new URLSearchParams({
      $group: group.join(', '),
      $limit: String(pageSize),
      $offset: String(offset),
      $order: order ?? group.join(', '),
      $select: select.join(', '),
      $where: where,
    })
    console.log(`[${label}] page ${pageCount + 1} offset ${offset}`)
    const response = await fetchWithRetry(`${SOCRATA_BASE_URL}?${params.toString()}`, label)
    const page = await response.json()

    rows.push(...page)
    pageCount += 1

    if (page.length < pageSize || (limit && rows.length >= limit) || (PAGE_LIMIT && pageCount >= PAGE_LIMIT)) {
      break
    }

    offset += page.length
  }

  if (limit) {
    return rows.slice(0, limit)
  }

  return rows
}

async function fetchWithRetry(url, label, attempt = 0) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  let response

  try {
    response = await fetch(url, { signal: controller.signal })
  } catch (error) {
    clearTimeout(timeout)

    if (attempt >= 4) {
      throw error
    }

    const backoffMs = 1_000 * (attempt + 1)
    console.log(`[${label}] retry ${attempt + 1} after network error`)
    await new Promise((resolve) => setTimeout(resolve, backoffMs))
    return fetchWithRetry(url, label, attempt + 1)
  } finally {
    clearTimeout(timeout)
  }

  if (response.ok) {
    return response
  }

  if (attempt >= 4) {
    throw new Error(`Failed request after retries: ${response.status} ${response.statusText}`)
  }

  const backoffMs = 1_000 * (attempt + 1)
  console.log(`[${label}] retry ${attempt + 1} after ${response.status} ${response.statusText}`)
  await new Promise((resolve) => setTimeout(resolve, backoffMs))
  return fetchWithRetry(url, label, attempt + 1)
}

function ingestProblemRows(seriesMap, rows, geographyType) {
  for (const row of rows) {
    const dayIndex = DATE_INDEX.get(row.day.slice(0, 10))

    if (dayIndex === undefined) {
      continue
    }

    const problem = sanitizeLabel(row.complaint_type)

    if (!problem) {
      continue
    }

    const geographyId =
      geographyType === 'citywide'
        ? 'citywide'
        : geographyType === 'borough'
          ? BOROUGH_NAME_TO_ID[row.borough]
          : parseCommunityBoard(row.community_board)?.id

    if (!geographyId) {
      continue
    }

    const geography = GEOGRAPHY_BY_ID.get(geographyId)

    if (!geography) {
      continue
    }

    const key = `problem|${problem}|${geographyId}`
    let series = seriesMap.get(key)

    if (!series) {
      series = {
        counts: [],
        detail: undefined,
        geography,
        level: 'problem',
        problem,
        seriesKey: key,
      }
      seriesMap.set(key, series)
    }

    series.counts.push(dayIndex, Number(row.n))
  }
}

function ingestDetailRows(seriesMap, rows, geographyType) {
  for (const row of rows) {
    const dayIndex = DATE_INDEX.get(row.day.slice(0, 10))

    if (dayIndex === undefined) {
      continue
    }

    const problem = sanitizeLabel(row.complaint_type)
    const detail = sanitizeLabel(row.descriptor)

    if (!problem || !detail) {
      continue
    }

    const geographyId =
      geographyType === 'citywide'
        ? 'citywide'
        : BOROUGH_NAME_TO_ID[row.borough]

    if (!geographyId) {
      continue
    }

    const geography = GEOGRAPHY_BY_ID.get(geographyId)

    if (!geography) {
      continue
    }

    const key = `detail|${problem}|${detail}|${geographyId}`
    let series = seriesMap.get(key)

    if (!series) {
      series = {
        counts: [],
        detail,
        geography,
        level: 'detail',
        problem,
        seriesKey: key,
      }
      seriesMap.set(key, series)
    }

    series.counts.push(dayIndex, Number(row.n))
  }
}

function evaluateSeriesCollection(seriesMap, options) {
  const evaluations = []

  for (const series of seriesMap.values()) {
    const evaluation = evaluateSeries(series, options)

    if (evaluation) {
      evaluations.push(evaluation)
    }
  }

  return evaluations
}

function evaluateSeries(series, options) {
  const counts = buildDenseCounts(series.counts)
  const comparableStartIndex = detectComparableStart(counts)
  const comparableCounts = counts.slice(comparableStartIndex)
  const comparableDays = comparableCounts.length
  const meanDaily = sumArray(comparableCounts) / Math.max(1, comparableDays)
  const zeroRate = comparableCounts.filter((value) => value === 0).length / Math.max(1, comparableDays)
  const sparse = comparableDays < 56 || zeroRate > 0.6 || meanDaily < 1
  const expected = buildExpectedSeries(counts, comparableStartIndex)
  const dailyStd = counts.map((value, index) => (value - expected[index]) / Math.sqrt(expected[index] + 1))
  const todaySignal = buildWindowSignal(dailyStd, 1, comparableStartIndex)
  const sevenDaySignal = buildWindowSignalFromCounts(counts, expected, 7, comparableStartIndex)
  const thirtyDaySignal = buildWindowSignalFromCounts(counts, expected, 30, comparableStartIndex)
  const quarterSignal = buildPeriodSignal(counts, expected, 'quarter', comparableStartIndex)
  const yearSignal = buildPeriodSignal(counts, expected, 'year', comparableStartIndex)

  const horizonScores = {
    today: sparse ? 0 : scoreSignal('today', todaySignal),
    '7d': scoreSignal('7d', sevenDaySignal),
    '30d': scoreSignal('30d', thirtyDaySignal),
    quarter: scoreSignal('quarter', quarterSignal),
    year: scoreSignal('year', yearSignal),
  }
  const dominantHorizon = HORIZONS.reduce((best, current) =>
    horizonScores[current] > horizonScores[best] ? current : best,
  )
  const dominantSignal = {
    today: todaySignal,
    '7d': sevenDaySignal,
    '30d': thirtyDaySignal,
    quarter: quarterSignal,
    year: yearSignal,
  }[dominantHorizon]
  const extremeProjectedPercentile = quarterSignal.projectedPercentile <= 5 ||
    quarterSignal.projectedPercentile >= 95 ||
    yearSignal.projectedPercentile <= 5 ||
    yearSignal.projectedPercentile >= 95
  const strongSignals = Object.values(horizonScores).filter((score) => score >= 3.5).length
  const artifacts = []

  if (comparableDays < 730) {
    artifacts.push('Limited history')
  }

  const direction = dominantSignal.raw >= 0 ? 'up' : 'down'
  const actual = roundCount(dominantSignal.actual)
  const expectedValue = roundCount(dominantSignal.expected)
  const deltaPct = expectedValue > 0 ? ((actual - expectedValue) / expectedValue) * 100 : 0
  const persistence = computePersistence(dailyStd, dominantHorizon, direction)
  const impact = Math.abs(actual - expectedValue)

  if (!(horizonScores[dominantHorizon] >= 4.5 || strongSignals >= 2 || extremeProjectedPercentile)) {
    return createSeriesEvaluation({
      actual,
      artifacts,
      comparableDays,
      comparableStartIndex,
      counts,
      dailyStd,
      deltaPct,
      detailIndexKey: series.detail ? `${series.problem}|${series.detail}` : series.problem,
      direction,
      dominantHorizon,
      expected: expectedValue,
      horizonScores,
      options,
      persistence,
      problemSeriesKey: `problem|${series.problem}|${series.geography.id}`,
      projectedPercentile: dominantHorizon === 'quarter'
        ? quarterSignal.projectedPercentile
        : dominantHorizon === 'year'
          ? yearSignal.projectedPercentile
          : undefined,
      rawSignal: dominantSignal,
      series,
      status: horizonScores[dominantHorizon] >= 4.5 || strongSignals >= 2 || extremeProjectedPercentile ? 'active' : 'watch',
      timeline: buildTimeline(counts, expected),
      historyTimeline: buildQuarterlyHistoryTimeline(counts, expected),
      impact,
    })
  }

  return createSeriesEvaluation({
    actual,
    artifacts,
    comparableDays,
    comparableStartIndex,
    counts,
    dailyStd,
    deltaPct,
    detailIndexKey: series.detail ? `${series.problem}|${series.detail}` : series.problem,
    direction,
    dominantHorizon,
    expected: expectedValue,
    horizonScores,
    options,
    persistence,
    problemSeriesKey: `problem|${series.problem}|${series.geography.id}`,
    projectedPercentile: dominantHorizon === 'quarter'
      ? quarterSignal.projectedPercentile
      : dominantHorizon === 'year'
        ? yearSignal.projectedPercentile
        : undefined,
    rawSignal: dominantSignal,
    series,
    status: 'active',
    timeline: buildTimeline(counts, expected),
    historyTimeline: buildQuarterlyHistoryTimeline(counts, expected),
    impact,
  })
}

function createSeriesEvaluation(input) {
  const severity = clamp(input.horizonScores[input.dominantHorizon] * 14, 0, 100)
  const impactScore = clamp(Math.log1p(input.impact) * 16, 0, 100)
  const persistenceScore = clamp(input.persistence * 100, 0, 100)

  return {
    actual: input.actual,
    artifacts: input.artifacts,
    comparableDays: input.comparableDays,
    comparableStart: DATE_KEYS[input.comparableStartIndex],
    counts: input.counts,
    dailyStd: input.dailyStd,
    deltaPct: round1(input.deltaPct),
    direction: input.direction,
    dominantHorizon: input.dominantHorizon,
    expected: input.expected,
    geography: input.series.geography,
    historyTimeline: input.historyTimeline,
    horizonScores: input.horizonScores,
    impact: input.impact,
    impactScore,
    level: input.series.level,
    persistenceScore,
    problem: input.series.problem,
    problemSeriesKey: input.problemSeriesKey,
    projectedPercentile: input.projectedPercentile,
    rawSignal: input.rawSignal,
    seriesKey: input.series.seriesKey,
    status: input.status,
    timeline: input.timeline,
    title: input.series.detail ?? input.series.problem,
    detail: input.series.detail,
    priority: 0,
    queueReason: '',
    secondarySignals: [],
    signal: {
      artifactPenalty: 0,
      breadth: 0,
      impact: impactScore,
      persistence: persistenceScore,
      severity,
      specificity: input.series.level === 'detail' ? 95 : 30,
    },
    sparkline: buildSparkline(input.counts, input.dominantHorizon),
    summary: '',
    tags: [],
    whyItMatters: '',
  }
}

function detectComparableStart(counts) {
  const firstNonZero = counts.findIndex((value) => value > 0)

  if (firstNonZero === -1) {
    return counts.length - 1
  }

  let latestBreak = firstNonZero

  for (let index = Math.max(56, firstNonZero + 56); index < counts.length - 56; index += 7) {
    const before = counts.slice(index - 56, index)
    const after = counts.slice(index, index + 56)
    const beforeMedian = median(before)
    const afterMedian = median(after)
    const levelShift = Math.abs(afterMedian - beforeMedian) / Math.max(1, beforeMedian)
    const zeroShift = Math.abs(zeroRate(before) - zeroRate(after))

    if (levelShift >= 0.35 || zeroShift >= 0.25) {
      latestBreak = index
    }
  }

  return latestBreak
}

function buildExpectedSeries(counts, comparableStartIndex) {
  const expected = new Float64Array(counts.length)
  const comparableCounts = counts.slice(comparableStartIndex)
  const logComparableCounts = comparableCounts.map((value) => Math.log1p(value))
  const overallMedian = median(logComparableCounts)
  const weeklyFactors = new Array(7).fill(0)
  const monthlyFactors = new Array(12).fill(0)

  if (comparableCounts.length >= 84) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const values = []

      for (let index = comparableStartIndex; index < counts.length; index += 1) {
        if (getWeekday(index) === weekday) {
          values.push(Math.log1p(counts[index]))
        }
      }

      weeklyFactors[weekday] = median(values) - overallMedian
    }

    const weeklySpread = Math.max(...weeklyFactors) - Math.min(...weeklyFactors)

    if (weeklySpread < 0.08) {
      weeklyFactors.fill(0)
    }
  }

  if (comparableCounts.length >= 730) {
    for (let month = 0; month < 12; month += 1) {
      const values = []

      for (let index = comparableStartIndex; index < counts.length; index += 1) {
        if (getMonth(index) === month) {
          values.push(Math.log1p(counts[index]))
        }
      }

      monthlyFactors[month] = median(values) - overallMedian
    }
  }

  let level = overallMedian

  for (let index = 0; index < counts.length; index += 1) {
    if (index < comparableStartIndex) {
      expected[index] = counts[index]
      continue
    }

    const seasonal = weeklyFactors[getWeekday(index)] + monthlyFactors[getMonth(index)]
    expected[index] = Math.max(0, Math.expm1(level + seasonal))
    const adjusted = Math.log1p(counts[index]) - seasonal
    const bounded = clamp(adjusted, level - 2.5, level + 2.5)
    level = 0.14 * bounded + 0.86 * level
  }

  return Array.from(expected, (value) => round2(value))
}

function buildWindowSignalFromCounts(counts, expected, windowSize, comparableStartIndex) {
  const standardized = []

  for (let endIndex = comparableStartIndex + windowSize - 1; endIndex < counts.length; endIndex += 1) {
    const actual = sumRange(counts, endIndex - windowSize + 1, endIndex)
    const expectedValue = sumRange(expected, endIndex - windowSize + 1, endIndex)
    standardized.push({
      actual,
      expected: expectedValue,
      raw: (actual - expectedValue) / Math.sqrt(expectedValue + 1),
    })
  }

  if (standardized.length === 0) {
    return {
      actual: 0,
      expected: 0,
      projectedPercentile: 50,
      raw: 0,
      score: 0,
    }
  }

  const latest = standardized.at(-1)
  const history = standardized.slice(0, -1).map((entry) => entry.raw)
  const score = robustScore(latest.raw, history)

  return {
    actual: latest.actual,
    expected: latest.expected,
    projectedPercentile: 50,
    raw: latest.raw,
    score,
  }
}

function buildWindowSignal(dailyStd, windowSize, comparableStartIndex) {
  const standardized = []

  for (let endIndex = comparableStartIndex + windowSize - 1; endIndex < dailyStd.length; endIndex += 1) {
    standardized.push(sumRange(dailyStd, endIndex - windowSize + 1, endIndex) / Math.sqrt(windowSize))
  }

  if (standardized.length === 0) {
    return {
      actual: 0,
      expected: 0,
      projectedPercentile: 50,
      raw: 0,
      score: 0,
    }
  }

  const latest = standardized.at(-1)
  const history = standardized.slice(0, -1)

  return {
    actual: 0,
    expected: 0,
    projectedPercentile: 50,
    raw: latest,
    score: robustScore(latest, history),
  }
}

function buildPeriodSignal(counts, expected, periodType, comparableStartIndex) {
  const currentPeriod = getCurrentPeriodBounds(periodType)
  const startIndex = DATE_INDEX.get(currentPeriod.start)
  const endIndex = DATE_INDEX.get(currentPeriod.end)

  if (startIndex === undefined || endIndex === undefined || endIndex < startIndex) {
    return {
      actual: 0,
      expected: 0,
      projectedPercentile: 50,
      raw: 0,
      score: 0,
    }
  }

  const progressLength = endIndex - startIndex + 1
  const actual = sumRange(counts, startIndex, endIndex)
  const expectedValue = sumRange(expected, startIndex, endIndex)
  const raw = (actual - expectedValue) / Math.sqrt(expectedValue + 1)
  const comparableValues = []
  const projectedTotals = []
  const fullPeriodLengths = []

  for (const periodStart of listPriorPeriodStarts(periodType, currentPeriod.start)) {
    const periodStartIndex = DATE_INDEX.get(periodStart)

    if (periodStartIndex === undefined || periodStartIndex < comparableStartIndex) {
      continue
    }

    const priorPeriod = getPeriodBoundsFromStart(periodType, periodStart)
    const priorProgressEndIndex = periodStartIndex + progressLength - 1
    const priorPeriodEndIndex = DATE_INDEX.get(priorPeriod.end)

    if (priorPeriodEndIndex === undefined || priorProgressEndIndex > priorPeriodEndIndex) {
      continue
    }

    const comparableActual = sumRange(counts, periodStartIndex, priorProgressEndIndex)
    const comparableExpected = sumRange(expected, periodStartIndex, priorProgressEndIndex)
    comparableValues.push((comparableActual - comparableExpected) / Math.sqrt(comparableExpected + 1))

    const fullActual = sumRange(counts, periodStartIndex, priorPeriodEndIndex)
    projectedTotals.push(fullActual)
    fullPeriodLengths.push(priorPeriodEndIndex - periodStartIndex + 1)
  }

  const fullPeriodDays = currentPeriod.totalDays
  const elapsedDays = progressLength
  const expectedRemaining = sumRange(expected, endIndex + 1, Math.min(counts.length - 1, startIndex + fullPeriodDays - 1))
  const paceRatio = actual / Math.max(1, expectedValue)
  const projectedFinish = actual + expectedRemaining * paceRatio
  const projectedPercentile = percentileRank(projectedTotals, projectedFinish)
  const percentileScore = percentileExtremeness(projectedPercentile)

  return {
    actual,
    expected: expectedValue,
    projectedPercentile,
    raw,
    score: Math.max(Math.abs(robustScore(raw, comparableValues)), percentileScore) * Math.sign(raw || 1),
  }
}

function scoreSignal(horizon, signal) {
  const minimums = HORIZON_MINIMUMS[horizon]
  const volume = Math.max(signal.actual, signal.expected)
  const diff = Math.abs(signal.actual - signal.expected)
  const deltaPct = Math.abs(((signal.actual - signal.expected) / Math.max(1, signal.expected)) * 100)

  if (volume < minimums.volume || diff < minimums.diff || deltaPct < minimums.deltaPct) {
    return 0
  }

  return round1(Math.abs(signal.score))
}

function buildDetailIndex(detailEvaluations) {
  const byProblemGeography = new Map()

  for (const evaluation of detailEvaluations) {
    const key = `${evaluation.problem}|${evaluation.geography.id}`
    const rows = byProblemGeography.get(key) ?? []
    rows.push(evaluation)
    byProblemGeography.set(key, rows)
  }

  for (const rows of byProblemGeography.values()) {
    rows.sort((left, right) => right.priority - left.priority)
  }

  return byProblemGeography
}

function selectProblemAlerts(problemEvaluations, detailIndex, detailBySeriesKey) {
  const alerts = []

  for (const evaluation of problemEvaluations) {
    if (evaluation.status !== 'active' && evaluation.horizonScores[evaluation.dominantHorizon] < 2.8) {
      continue
    }

    const candidateDetails = detailIndex.get(`${evaluation.problem}|${evaluation.geography.id}`) ?? []
    const parentExcess = Math.max(0, sumRecentExcess(evaluation.timeline, 30))
    const bestDetail = candidateDetails.find((detail) => {
      const detailExcess = Math.max(0, sumRecentExcess(detail.timeline, 30))
      return detail.priority >= evaluation.priority * 0.8 && detailExcess >= parentExcess * 0.6
    })

    if (bestDetail) {
      bestDetail.artifacts = mergeArtifacts(bestDetail.artifacts, detectTaxonomyArtifact(evaluation, candidateDetails))
      bestDetail.priority = finalizePriority(bestDetail, problemEvaluations)
      alerts.push(bestDetail)
      continue
    }

    evaluation.artifacts = mergeArtifacts(evaluation.artifacts, detectTaxonomyArtifact(evaluation, candidateDetails))
    evaluation.priority = finalizePriority(evaluation, problemEvaluations)
    alerts.push(evaluation)
  }

  return alerts.sort((left, right) => right.priority - left.priority)
}

function finalizePriority(evaluation, allProblemEvaluations) {
  evaluation.signal.breadth = computeBreadthScore(evaluation, allProblemEvaluations)
  evaluation.signal.specificity = evaluation.level === 'detail' ? 95 : evaluation.signal.specificity
  evaluation.signal.artifactPenalty = evaluation.artifacts.reduce(
    (sum, artifact) => sum + ARTIFACT_PENALTIES[artifact],
    0,
  )
  const score = (
    evaluation.signal.severity * 0.45 +
    evaluation.signal.impact * 0.25 +
    evaluation.signal.persistence * 0.15 +
    evaluation.signal.breadth * 0.1 +
    evaluation.signal.specificity * 0.05 -
    evaluation.signal.artifactPenalty
  )
  evaluation.priority = Math.max(0, Math.min(100, Math.round(score)))
  evaluation.summary = createSummary(evaluation)
  evaluation.whyItMatters = createWhyItMatters(evaluation)
  evaluation.queueReason = createQueueReason(evaluation)
  evaluation.secondarySignals = buildSecondarySignals(evaluation)
  evaluation.tags = buildTags(evaluation)
  return evaluation.priority
}

function mergeGeographyDuplicates(alerts) {
  const citywideByProblem = new Map()

  for (const evaluation of alerts) {
    if (evaluation.geography.type === 'citywide') {
      citywideByProblem.set(`${evaluation.problem}|${evaluation.detail ?? ''}`, evaluation)
    }
  }

  return alerts.filter((evaluation) => {
    if (evaluation.geography.type === 'citywide') {
      return true
    }

    const citywide = citywideByProblem.get(`${evaluation.problem}|${evaluation.detail ?? ''}`)

    if (!citywide) {
      return true
    }

    if (citywide.priority >= evaluation.priority + 12 && citywide.signal.breadth >= 70) {
      return false
    }

    return true
  })
}

function buildAlertRecord(evaluation, detailIndex, problemEvaluations) {
  const map = buildDistrictMap(evaluation.problem, evaluation.dominantHorizon, problemEvaluations, evaluation.geography.id)
  const contributors = buildContributors(evaluation, detailIndex)
  const id = `${slugify(evaluation.problem)}-${evaluation.detail ? `${slugify(evaluation.detail)}-` : ''}${evaluation.geography.id}-${evaluation.dominantHorizon}`

  return {
    actual: evaluation.actual,
    artifacts: evaluation.artifacts,
    comparabilityStart: evaluation.comparableStart,
    contributors,
    deltaPct: round1(evaluation.deltaPct),
    direction: evaluation.direction,
    expected: evaluation.expected,
    geography: evaluation.geography,
    historyTimeline: evaluation.historyTimeline,
    horizon: evaluation.dominantHorizon,
    horizonScores: evaluation.horizonScores,
    id,
    map,
    priority: evaluation.priority,
    problem: evaluation.problem,
    projectedPercentile: evaluation.projectedPercentile,
    queueReason: evaluation.queueReason,
    secondarySignals: evaluation.secondarySignals,
    signal: evaluation.signal,
    sparkline: evaluation.sparkline,
    summary: evaluation.summary,
    surfaceLevel: evaluation.level,
    tags: evaluation.tags,
    timeline: evaluation.timeline,
    title: evaluation.title,
    whyItMatters: evaluation.whyItMatters,
    detail: evaluation.detail,
  }
}

function buildFixedHorizon(alertRecords) {
  return {
    '7d': alertRecords.filter((alert) => alert.horizon === '7d'),
    '30d': alertRecords.filter((alert) => alert.horizon === '30d'),
    quarter: alertRecords.filter((alert) => alert.horizon === 'quarter'),
    year: alertRecords.filter((alert) => alert.horizon === 'year'),
  }
}

function buildEntityIndex(problemEvaluations, detailEvaluations, detailIndex, alertMap) {
  const entities = []
  const problemNames = [...new Set(problemEvaluations.map((evaluation) => evaluation.problem))].sort()

  for (const problem of problemNames) {
    const related = problemEvaluations
      .filter((evaluation) => evaluation.problem === problem)
      .sort((left, right) => right.priority - left.priority)
    const top = related[0]

    if (!top) {
      continue
    }

    const id = `problem:${problem}`
    const geographyBreakdown = related
      .slice(0, 12)
      .map((evaluation) => ({
        actual: evaluation.actual,
        deltaPct: evaluation.deltaPct,
        expected: evaluation.expected,
        geography: evaluation.geography,
        priority: evaluation.priority,
        status: evaluation.priority >= 78 ? 'active' : evaluation.priority >= 58 ? 'watch' : 'quiet',
      }))

    entities.push({
      activeAlertCount: related.filter((evaluation) => evaluation.priority >= 78).length,
      artifacts: [...new Set(related.flatMap((evaluation) => evaluation.artifacts))],
      contributors: buildContributors(top, detailIndex),
      currentStatus: top.priority >= 78 ? 'active' : top.priority >= 58 ? 'watch' : 'quiet',
      defaultHorizon: top.dominantHorizon,
      geographyBreakdown,
      historyTimeline: top.historyTimeline,
      horizonScores: maxHorizonScores(related),
      id,
      map: buildDistrictMap(problem, top.dominantHorizon, problemEvaluations),
      name: problem,
      sparkline: top.sparkline,
      summary: `${top.geography.shortLabel} is the clearest live view for ${problem} right now, with the strongest pull on ${formatHorizon(top.dominantHorizon)}.`,
      timeline: top.timeline,
      topAlertId: [...alertMap.values()].find((alert) => alert.problem === problem)?.id,
      type: 'problem',
    })
  }

  const detailGroups = new Map()

  for (const evaluation of detailEvaluations) {
    const key = `${evaluation.problem}|${evaluation.detail}`
    const rows = detailGroups.get(key) ?? []
    rows.push(evaluation)
    detailGroups.set(key, rows)
  }

  for (const [key, related] of detailGroups.entries()) {
    related.sort((left, right) => right.priority - left.priority)
    const top = related[0]

    if (!top) {
      continue
    }

    const [problem, detail] = key.split('|')
    const id = `detail:${problem}:${detail}`
    const geographyBreakdown = related
      .slice(0, 8)
      .map((evaluation) => ({
        actual: evaluation.actual,
        deltaPct: evaluation.deltaPct,
        expected: evaluation.expected,
        geography: evaluation.geography,
        priority: evaluation.priority,
        status: evaluation.priority >= 78 ? 'active' : evaluation.priority >= 58 ? 'watch' : 'quiet',
      }))

    entities.push({
      activeAlertCount: related.filter((evaluation) => evaluation.priority >= 78).length,
      artifacts: [...new Set(related.flatMap((evaluation) => evaluation.artifacts))],
      contributors: buildContributors(top, detailIndex),
      currentStatus: top.priority >= 78 ? 'active' : top.priority >= 58 ? 'watch' : 'quiet',
      defaultHorizon: top.dominantHorizon,
      geographyBreakdown,
      historyTimeline: top.historyTimeline,
      horizonScores: maxHorizonScores(related),
      id,
      map: buildDistrictMap(problem, top.dominantHorizon, problemEvaluations),
      name: detail,
      parentProblem: problem,
      sparkline: top.sparkline,
      summary: `${detail} is on ${top.priority >= 78 ? 'active' : top.priority >= 58 ? 'watch' : 'quiet'} within ${problem}, led by ${top.geography.shortLabel}.`,
      timeline: top.timeline,
      topAlertId: [...alertMap.values()].find(
        (alert) => alert.problem === problem && alert.detail === detail,
      )?.id,
      type: 'detail',
    })
  }

  return entities.sort((left, right) => {
    const statusOrder = { active: 0, watch: 1, quiet: 2 }
    const statusDiff = statusOrder[left.currentStatus] - statusOrder[right.currentStatus]

    if (statusDiff !== 0) {
      return statusDiff
    }

    return left.name.localeCompare(right.name)
  })
}

function buildDistrictMap(problem, horizon, problemEvaluations, selectedGeographyId) {
  const boardEvaluations = problemEvaluations.filter(
    (evaluation) => evaluation.problem === problem && evaluation.geography.type === 'community-board',
  )
  const byGeographyId = new Map(boardEvaluations.map((evaluation) => [evaluation.geography.id, evaluation]))
  const windowSize = horizon === 'today'
    ? 1
    : horizon === '7d'
      ? 7
      : horizon === '30d'
        ? 30
        : horizon === 'quarter'
          ? getCurrentPeriodBounds('quarter').totalDays
          : getCurrentPeriodBounds('year').totalDays

  return BOARD_DEFINITIONS.map((board) => {
    const evaluation = byGeographyId.get(board.id)
    const actual = evaluation
      ? roundCount(sumRecentActual(evaluation.timeline, windowSize))
      : 0
    const expected = evaluation
      ? roundCount(sumRecentExpected(evaluation.timeline, windowSize))
      : 0
    const intensity = expected > 0 ? actual / expected : 1

    return {
      borough: board.borough,
      id: board.id,
      label: board.label,
      actual,
      code: board.code,
      expected,
      intensity: round2(intensity),
      isFocus: selectedGeographyId === board.id,
    }
  })
}

function buildContributors(evaluation, detailIndex) {
  if (evaluation.level === 'detail') {
    const siblings = detailIndex.get(`${evaluation.problem}|${evaluation.geography.id}`) ?? []

    return siblings
      .slice(0, 5)
      .map((detailEvaluation) => ({
        actual: detailEvaluation.actual,
        expected: detailEvaluation.expected,
        name: detailEvaluation.detail,
        share: round1(
          (Math.max(0, detailEvaluation.actual - detailEvaluation.expected) /
            Math.max(1, siblings.reduce((sum, row) => sum + Math.max(0, row.actual - row.expected), 0))) *
            100,
        ),
      }))
  }

  const rows = detailIndex.get(`${evaluation.problem}|${evaluation.geography.id}`) ?? []
  const totalExcess = rows.reduce((sum, row) => sum + Math.max(0, row.actual - row.expected), 0)

  return rows
    .slice(0, 5)
    .map((detailEvaluation) => ({
      actual: detailEvaluation.actual,
      expected: detailEvaluation.expected,
      name: detailEvaluation.detail,
      share: round1(
        (Math.max(0, detailEvaluation.actual - detailEvaluation.expected) / Math.max(1, totalExcess)) * 100,
      ),
    }))
}

function detectPanelWideBreak(problemEvaluations) {
  const eligible = problemEvaluations.filter((evaluation) => evaluation.geography.type !== 'community-board')
  const noisy = eligible.filter((evaluation) => evaluation.horizonScores.today >= 5).length / Math.max(1, eligible.length)
  return noisy >= 0.18
}

function applyPanelWideBreak(evaluations, panelWideBreak) {
  if (!panelWideBreak) {
    return
  }

  for (const evaluation of evaluations) {
    if (evaluation.horizonScores.today >= 4) {
      evaluation.artifacts = mergeArtifacts(evaluation.artifacts, 'Panel-wide break')
    }
  }
}

function detectTaxonomyArtifact(parentEvaluation, candidateDetails) {
  if (!candidateDetails.length) {
    return []
  }

  const parentCurrent = sumRecentActual(parentEvaluation.timeline, 30)
  const parentPrevious = sumPriorActual(parentEvaluation.timeline, 30, 30)

  if (parentPrevious <= 0) {
    return []
  }

  const parentDelta = Math.abs(parentCurrent - parentPrevious) / parentPrevious

  if (parentDelta >= 0.15) {
    return []
  }

  const shares = candidateDetails
    .map((evaluation) => ({
      currentShare: sumRecentActual(evaluation.timeline, 30) / Math.max(1, parentCurrent),
      previousShare: sumPriorActual(evaluation.timeline, 30, 30) / Math.max(1, parentPrevious),
    }))
    .map(({ currentShare, previousShare }) => Math.abs(currentShare - previousShare))

  return shares.some((shareShift) => shareShift >= 0.2) ? ['Possible taxonomy artifact'] : []
}

function computeBreadthScore(evaluation, allProblemEvaluations) {
  const related = allProblemEvaluations.filter(
    (row) => row.problem === evaluation.problem && row.geography.id !== evaluation.geography.id,
  )
  const sameDirection = related.filter(
    (row) =>
      row.direction === evaluation.direction &&
      row.horizonScores[row.dominantHorizon] >= 3 &&
      (evaluation.geography.type === 'citywide' ||
        row.geography.type === 'borough' ||
        row.geography.borough === evaluation.geography.borough),
  ).length

  return clamp(sameDirection * 18 + (evaluation.geography.type === 'citywide' ? 25 : 5), 0, 100)
}

function computePersistence(dailyStd, horizon, direction) {
  const window = horizon === 'today'
    ? 7
    : horizon === '7d'
      ? 21
      : horizon === '30d'
        ? 45
        : horizon === 'quarter'
          ? 90
          : 120
  const slice = dailyStd.slice(-window)
  const sign = direction === 'up' ? 1 : -1
  const strongDays = slice.filter((value) => value * sign > 0.5).length
  return strongDays / Math.max(1, slice.length)
}

function buildTimeline(counts, expected) {
  const startIndex = Math.max(0, counts.length - 540)
  const points = []

  for (let index = startIndex; index < counts.length; index += 1) {
    points.push({
      actual: roundCount(counts[index]),
      date: DATE_KEYS[index],
      expected: roundCount(expected[index]),
    })
  }

  return points
}

function buildQuarterlyHistoryTimeline(counts, expected) {
  const buckets = new Map()

  for (let index = 0; index < counts.length; index += 1) {
    const date = parseDateKey(DATE_KEYS[index])
    const key = `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`
    const current = buckets.get(key) ?? {
      actual: 0,
      date: quarterStartDateKey(date),
      expected: 0,
    }
    current.actual += counts[index]
    current.expected += expected[index]
    buckets.set(key, current)
  }

  return [...buckets.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((point) => ({
      actual: roundCount(point.actual),
      date: point.date,
      expected: roundCount(point.expected),
    }))
}

function buildSparkline(counts, horizon) {
  const window = horizon === 'today'
    ? 28
    : horizon === '7d'
      ? 90
      : horizon === '30d'
        ? 180
        : horizon === 'quarter'
          ? 270
          : 365
  const slice = counts.slice(-window)

  if (horizon === 'today') {
    return slice.slice(-28).map(round2)
  }

  if (horizon === '7d' || horizon === '30d') {
    const size = horizon === '7d' ? 7 : 30
    const values = []

    for (let index = size - 1; index < slice.length; index += 1) {
      values.push(round2(sumRange(slice, index - size + 1, index)))
    }

    return values.slice(-48)
  }

  const values = []

  for (let index = 89; index < slice.length; index += 90) {
    values.push(round2(sumRange(slice, index - 89, index)))
  }

  return values.length ? values : slice.slice(-12).map(round2)
}

function createSummary(evaluation) {
  if (evaluation.dominantHorizon === 'today') {
    return evaluation.direction === 'up'
      ? 'Today is running well above the adjusted baseline after a steadier recent run.'
      : 'Today fell sharply below the adjusted baseline after a steadier recent run.'
  }

  if (evaluation.dominantHorizon === '7d') {
    return evaluation.direction === 'up'
      ? 'The last week is materially above the adjusted path and does not read as a routine weekly peak.'
      : 'The last week is materially below the adjusted path and breaks the recent weekly rhythm.'
  }

  if (evaluation.dominantHorizon === '30d') {
    return evaluation.direction === 'up'
      ? 'The last month has shifted into a higher regime instead of fading after a short burst.'
      : 'The last month has shifted into a lower regime instead of reverting toward its usual path.'
  }

  if (evaluation.dominantHorizon === 'quarter') {
    return evaluation.direction === 'up'
      ? 'Quarter to date is running ahead of the expected path and is landing in an unusually high historical tail.'
      : 'Quarter to date is running below the expected path and is landing in an unusually low historical tail.'
  }

  return evaluation.direction === 'up'
    ? 'Year to date is on pace for an unusually high finish relative to recent comparable years.'
    : 'Year to date is on pace for an unusually low finish relative to recent comparable years.'
}

function createWhyItMatters(evaluation) {
  const breadthText = evaluation.signal.breadth >= 65
    ? 'The signal is showing up across related geographies, which makes it harder to dismiss as local noise.'
    : 'The signal is concentrated enough to be informative instead of just reflecting broad citywide drift.'
  const impactText = evaluation.impact >= 100
    ? 'The excess volume is large enough to matter operationally.'
    : 'Even at moderate volume, the deviation is strong relative to this series baseline.'

  return `${impactText} ${breadthText}`
}

function createQueueReason(evaluation) {
  if (evaluation.projectedPercentile !== undefined && (evaluation.projectedPercentile <= 5 || evaluation.projectedPercentile >= 95)) {
    return `${formatHorizon(evaluation.dominantHorizon)} projected finish is in a historical tail.`
  }

  const strongSignals = HORIZONS.filter((horizon) => evaluation.horizonScores[horizon] >= 3.5)

  if (strongSignals.length >= 2) {
    return `Multiple horizons are elevated, led by ${formatHorizon(evaluation.dominantHorizon)}.`
  }

  return `${formatHorizon(evaluation.dominantHorizon)} is the clearest current anomaly.`
}

function buildSecondarySignals(evaluation) {
  return HORIZONS
    .filter(
      (horizon) =>
        horizon !== evaluation.dominantHorizon &&
        evaluation.horizonScores[horizon] >= 3.25,
    )
    .map((horizon) => `${formatHorizon(horizon)} also elevated`)
    .slice(0, 3)
}

function buildTags(evaluation) {
  const tags = []

  if (evaluation.level === 'detail') {
    tags.push('Problem detail')
  }

  if (evaluation.geography.type === 'community-board') {
    tags.push('Local hotspot')
  }

  if (evaluation.signal.breadth >= 65) {
    tags.push('Broad signal')
  }

  if (evaluation.projectedPercentile !== undefined && evaluation.projectedPercentile >= 95) {
    tags.push('Projected top tail')
  }

  if (evaluation.projectedPercentile !== undefined && evaluation.projectedPercentile <= 5) {
    tags.push('Projected bottom tail')
  }

  return tags
}

function toAlertSummary(alert) {
  return {
    actual: alert.actual,
    artifacts: alert.artifacts,
    deltaPct: alert.deltaPct,
    direction: alert.direction,
    expected: alert.expected,
    geography: alert.geography,
    horizon: alert.horizon,
    horizonScores: alert.horizonScores,
    id: alert.id,
    priority: alert.priority,
    problem: alert.problem,
    projectedPercentile: alert.projectedPercentile,
    sparkline: alert.sparkline,
    summary: alert.summary,
    surfaceLevel: alert.surfaceLevel,
    title: alert.title,
    detail: alert.detail,
  }
}

function toEntitySummary(entity) {
  return {
    activeAlertCount: entity.activeAlertCount,
    currentStatus: entity.currentStatus,
    defaultHorizon: entity.defaultHorizon,
    horizonScores: entity.horizonScores,
    id: entity.id,
    name: entity.name,
    parentProblem: entity.parentProblem,
    sparkline: entity.sparkline,
    summary: entity.summary,
    topAlertId: entity.topAlertId,
    type: entity.type,
  }
}

async function prepareOutputDirectories() {
  await mkdir(ALERT_OUTPUT_ROOT, { recursive: true })
  await mkdir(ENTITY_OUTPUT_ROOT, { recursive: true })

  for (const entry of await readdir(ALERT_OUTPUT_ROOT)) {
    await rm(path.join(ALERT_OUTPUT_ROOT, entry), { force: true })
  }

  for (const entry of await readdir(ENTITY_OUTPUT_ROOT)) {
    await rm(path.join(ENTITY_OUTPUT_ROOT, entry), { force: true })
  }
}

async function writeAlertFiles(alerts) {
  await Promise.all(
    alerts.map((alert) =>
      writeJson(path.join(ALERT_OUTPUT_ROOT, `${alert.id}.json`), alert),
    ),
  )
}

async function writeEntityFiles(entities) {
  await Promise.all(
    entities.map((entity) =>
      writeJson(path.join(ENTITY_OUTPUT_ROOT, `${slugify(entity.id)}.json`), entity),
    ),
  )
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`)
}

function buildDenseCounts(points) {
  const counts = new Array(DATE_KEYS.length).fill(0)

  for (let index = 0; index < points.length; index += 2) {
    counts[points[index]] = points[index + 1]
  }

  return counts
}

function buildDateKeys(startDate, endDate) {
  const dates = []
  const cursor = new Date(startDate)

  while (cursor <= endDate) {
    dates.push(formatDateKey(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return dates
}

function buildPartitions(startDate, endDate, partitionMonths) {
  const partitions = []
  let cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1))
  const finalExclusive = addDays(endDate, 1)

  while (cursor < finalExclusive) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + partitionMonths, 1))
    partitions.push({
      endExclusive: next < finalExclusive ? next : finalExclusive,
      startDate: cursor < startDate ? startDate : cursor,
    })
    cursor = next
  }

  return partitions
}

function buildBoardDefinitions() {
  return BOROUGH_META.flatMap((borough) =>
    Array.from({ length: borough.boardCount }, (_value, index) => {
      const boardNumber = index + 1

      return {
        borough: borough.label,
        code: `${borough.codePrefix}${String(boardNumber).padStart(2, '0')}`,
        id: `${borough.id}-cb${boardNumber}`,
        label: `${borough.label} Community Board ${boardNumber}`,
        shortLabel: `${borough.label.slice(0, 2).toUpperCase()} ${boardNumber}`,
      }
    }),
  )
}

function buildGeographies() {
  return [
    { id: 'citywide', label: 'Citywide', shortLabel: 'Citywide', type: 'citywide' },
    ...BOROUGH_META.map((borough) => ({
      borough: borough.label,
      id: borough.id,
      label: borough.label,
      shortLabel: borough.shortLabel,
      type: 'borough',
    })),
    ...BOARD_DEFINITIONS.map((board) => ({
      borough: board.borough,
      id: board.id,
      label: board.label,
      shortLabel: board.shortLabel,
      type: 'community-board',
    })),
  ]
}

function parseCommunityBoard(value) {
  if (!value || value.startsWith('Unspecified')) {
    return undefined
  }

  const match = value.match(/^(\d{2})\s+(.+)$/)

  if (!match) {
    return undefined
  }

  const boardNumber = Number(match[1])
  const boroughName = match[2].trim()
  const boroughId = BOROUGH_NAME_TO_ID[boroughName]

  if (!boroughId) {
    return undefined
  }

  return {
    id: `${boroughId}-cb${boardNumber}`,
  }
}

function getCurrentPeriodBounds(periodType) {
  const currentDateKey = formatDateKey(END_DATE)
  return getPeriodBoundsFromStart(periodType, periodStartDateKey(periodType, currentDateKey))
}

function getPeriodBoundsFromStart(periodType, periodStart) {
  const startDate = parseDateKey(periodStart)
  const endDate = new Date(startDate)

  if (periodType === 'quarter') {
    endDate.setUTCMonth(endDate.getUTCMonth() + 3, 0)
  } else {
    endDate.setUTCFullYear(endDate.getUTCFullYear() + 1, 0, 0)
  }

  const totalDays = Math.round((endDate - startDate) / 86_400_000) + 1

  return {
    end: formatDateKey(endDate),
    start: periodStart,
    totalDays,
  }
}

function listPriorPeriodStarts(periodType, currentPeriodStart) {
  const starts = []
  let cursor = parseDateKey(currentPeriodStart)

  for (;;) {
    if (periodType === 'quarter') {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 3, 1))
    } else {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear() - 1, 0, 1))
    }

    if (cursor < START_DATE) {
      break
    }

    starts.push(formatDateKey(cursor))
  }

  return starts
}

function periodStartDateKey(periodType, dateKey) {
  const date = parseDateKey(dateKey)

  if (periodType === 'quarter') {
    const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3
    return formatDateKey(new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth, 1)))
  }

  return formatDateKey(new Date(Date.UTC(date.getUTCFullYear(), 0, 1)))
}

function quarterStartDateKey(date) {
  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3
  return formatDateKey(new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth, 1)))
}

function maxHorizonScores(evaluations) {
  return HORIZONS.reduce(
    (result, horizon) => ({
      ...result,
      [horizon]: round1(Math.max(...evaluations.map((evaluation) => evaluation.horizonScores[horizon]))),
    }),
    {},
  )
}

function robustScore(value, history) {
  if (history.length < 12) {
    return 0
  }

  const center = median(history)
  const deviations = history.map((entry) => Math.abs(entry - center))
  const scale = median(deviations) * 1.4826

  if (scale < 0.35) {
    return value - center
  }

  return (value - center) / scale
}

function percentileRank(values, value) {
  if (!values.length) {
    return 50
  }

  const sorted = [...values].sort((left, right) => left - right)
  const below = sorted.filter((entry) => entry < value).length
  const equal = sorted.filter((entry) => entry === value).length

  return ((below + equal * 0.5) / sorted.length) * 100
}

function percentileExtremeness(percentile) {
  return Math.max(0, 5 - Math.min(percentile, 100 - percentile))
}

function mergeArtifacts(existingArtifacts, nextArtifacts) {
  const values = Array.isArray(nextArtifacts) ? nextArtifacts : [nextArtifacts]
  return [...new Set([...existingArtifacts, ...values.filter(Boolean)])]
}

function sumRecentExcess(timeline, window) {
  return timeline.slice(-window).reduce((sum, point) => sum + (point.actual - point.expected), 0)
}

function sumRecentActual(timeline, window) {
  return timeline.slice(-window).reduce((sum, point) => sum + point.actual, 0)
}

function sumRecentExpected(timeline, window) {
  return timeline.slice(-window).reduce((sum, point) => sum + point.expected, 0)
}

function sumPriorActual(timeline, window, offset) {
  return timeline.slice(-(window + offset), -offset).reduce((sum, point) => sum + point.actual, 0)
}

function sumRange(values, startIndex, endIndex) {
  let sum = 0

  for (let index = Math.max(0, startIndex); index <= Math.min(values.length - 1, endIndex); index += 1) {
    sum += values[index]
  }

  return sum
}

function sumArray(values) {
  return values.reduce((sum, value) => sum + value, 0)
}

function median(values) {
  if (!values.length) {
    return 0
  }

  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2
  }

  return sorted[midpoint]
}

function zeroRate(values) {
  if (!values.length) {
    return 0
  }

  return values.filter((value) => value === 0).length / values.length
}

function getWeekday(dateIndex) {
  return parseDateKey(DATE_KEYS[dateIndex]).getUTCDay()
}

function getMonth(dateIndex) {
  return parseDateKey(DATE_KEYS[dateIndex]).getUTCMonth()
}

function sanitizeLabel(value) {
  if (!value) {
    return undefined
  }

  return String(value).trim()
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120)
}

function quoteList(values) {
  return values.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(', ')
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function round1(value) {
  return Number(value.toFixed(1))
}

function round2(value) {
  return Number(value.toFixed(2))
}

function roundCount(value) {
  return Math.max(0, Math.round(value))
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addDays(date, days) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10)
}

function parseDateKey(value) {
  return new Date(`${value}T00:00:00.000Z`)
}

function formatHorizon(horizon) {
  switch (horizon) {
    case 'today':
      return 'Today'
    case '7d':
      return '7 days'
    case '30d':
      return '30 days'
    case 'quarter':
      return 'Quarter'
    case 'year':
      return 'Year'
    default:
      return horizon
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
