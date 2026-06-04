import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DATASET_ID = 'erm2-nwe9'
const SOCRATA_BASE_URL = `https://data.cityofnewyork.us/resource/${DATASET_ID}.json`
const SOCRATA_APP_TOKEN = readRequiredEnv('NYC_OPENDATA_APP_TOKEN', 'NYC_OPEN_DATA_APP_TOKEN')
const SOCRATA_REQUEST_TIMEOUT_MS = Number(process.env.SOCRATA_REQUEST_TIMEOUT_MS ?? 300_000)
const OUTPUT_ROOT = path.resolve('public/data')
const ALERT_OUTPUT_ROOT = path.join(OUTPUT_ROOT, 'alerts')
const ENTITY_OUTPUT_ROOT = path.join(OUTPUT_ROOT, 'entities')
const INDEX_OUTPUT_PATH = path.join(OUTPUT_ROOT, 'dashboard-index.json')
const AGGREGATE_CACHE_ROOT = path.resolve(process.env.DASHBOARD_AGGREGATE_CACHE_DIR ?? '.dashboard-cache/aggregates')
const WINDOW_DAYS = process.env.DASHBOARD_WINDOW_DAYS ? Number(process.env.DASHBOARD_WINDOW_DAYS) : undefined
const WINDOW_YEARS = Number(process.env.DASHBOARD_WINDOW_YEARS ?? 5)
const COMPLETENESS_LOOKBACK_DAYS = Number(process.env.DASHBOARD_COMPLETENESS_LOOKBACK_DAYS ?? 56)
const COMPLETENESS_MIN_RATIO = Number(process.env.DASHBOARD_COMPLETENESS_MIN_RATIO ?? 0.65)
const COMPLETENESS_MIN_PRIOR_WEEKS = Number(process.env.DASHBOARD_COMPLETENESS_MIN_PRIOR_WEEKS ?? 3)
const COMPLETENESS_MIN_COUNT = Number(process.env.DASHBOARD_COMPLETENESS_MIN_COUNT ?? 1000)
const FALLBACK_DATA_LAG_DAYS = Number(process.env.DASHBOARD_FALLBACK_DATA_LAG_DAYS ?? 3)
const TOP_DETAIL_PROBLEM_COUNT = 15
const TOP_DETAIL_CACHE_PATH = path.resolve(process.env.DASHBOARD_TOP_DETAIL_CACHE_PATH ?? '.dashboard-cache/top-detail-problems.json')
const TOP_DETAIL_REFRESH_DAYS = Number(process.env.DASHBOARD_TOP_DETAIL_REFRESH_DAYS ?? 30)
const TOP_DETAIL_EXCEPTION_LOOKBACK_DAYS = Number(process.env.DASHBOARD_TOP_DETAIL_EXCEPTION_LOOKBACK_DAYS ?? 7)
const TOP_DETAIL_EXCEPTION_CANDIDATE_LIMIT = Number(process.env.DASHBOARD_TOP_DETAIL_EXCEPTION_CANDIDATE_LIMIT ?? 25)
const TOP_DETAIL_EXCEPTION_MIN_CALLS = Number(process.env.DASHBOARD_TOP_DETAIL_EXCEPTION_MIN_CALLS ?? 5_000)
const TOP_DETAIL_EXCEPTION_RATIO = Number(process.env.DASHBOARD_TOP_DETAIL_EXCEPTION_RATIO ?? 4)
const TOP_DETAIL_EXCEPTION_MAX_ADDITIONS = Number(process.env.DASHBOARD_TOP_DETAIL_EXCEPTION_MAX_ADDITIONS ?? 1)
const AGGREGATE_PAGE_SIZE = Number(process.env.DASHBOARD_PAGE_SIZE ?? 500_000)
const PAGE_LIMIT = process.env.DASHBOARD_PAGE_LIMIT ? Number(process.env.DASHBOARD_PAGE_LIMIT) : undefined
const PARTITION_MONTHS = Number(process.env.DASHBOARD_PARTITION_MONTHS ?? 3)
const CACHE_REFRESH_LOOKBACK_DAYS = Number(process.env.DASHBOARD_CACHE_REFRESH_LOOKBACK_DAYS ?? COMPLETENESS_LOOKBACK_DAYS)
const ACTIVE_PRIORITY_FLOOR = 58
const LONG_HORIZON_ACTIVE_SCORE = 12
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
const BOARD_DEFINITIONS = buildBoardDefinitions()
const GEOGRAPHIES = buildGeographies()
const GEOGRAPHY_BY_ID = new Map(GEOGRAPHIES.map((geography) => [geography.id, geography]))
let END_DATE
let START_DATE
let DATE_KEYS
let DATE_INDEX

async function main() {
  const completeness = await resolveCompleteEndDate()
  END_DATE = completeness.endDate
  START_DATE = resolveWindowStartDate(END_DATE)
  DATE_KEYS = buildDateKeys(START_DATE, END_DATE)
  DATE_INDEX = new Map(DATE_KEYS.map((dateKey, index) => [dateKey, index]))

  console.log(
    `Using ${formatDateKey(END_DATE)} as latest complete day (${completeness.reason})`,
  )
  console.log(`Building dashboard for ${formatDateKey(START_DATE)} to ${formatDateKey(END_DATE)}`)

  const citywideProblemRows = await fetchPartitionedAggregates({
    label: 'problem-citywide',
    extraWhere: '',
    group: ['day', 'complaint_type'],
    partitionMonths: PARTITION_MONTHS,
    select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'count(*) as n'],
    startDate: START_DATE,
  })
  const topDetailProblems = await selectTopDetailProblems(citywideProblemRows)
  console.log(`Tracking detail series for ${topDetailProblems.length} high-volume problems`)
  const boroughProblemRows = await fetchPartitionedAggregates({
    label: 'problem-borough',
    extraWhere: `borough in (${quoteList(Object.keys(BOROUGH_NAME_TO_ID))})`,
    group: ['day', 'complaint_type', 'borough'],
    partitionMonths: PARTITION_MONTHS,
    select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'borough', 'count(*) as n'],
    startDate: START_DATE,
  })
  const boardProblemRows = await fetchPartitionedAggregates({
    label: 'problem-board',
    extraWhere: 'community_board is not null',
    group: ['day', 'complaint_type', 'community_board'],
    partitionMonths: PARTITION_MONTHS,
    select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'community_board', 'count(*) as n'],
    startDate: START_DATE,
  })
  const citywideDetailRows = await fetchPartitionedAggregates({
    label: 'detail-citywide',
    extraWhere: `descriptor is not null AND complaint_type in (${quoteList(topDetailProblems)})`,
    group: ['day', 'complaint_type', 'descriptor'],
    partitionMonths: PARTITION_MONTHS,
    select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'descriptor', 'count(*) as n'],
    startDate: START_DATE,
  })
  const boroughDetailRows = await fetchPartitionedAggregates({
    label: 'detail-borough',
    extraWhere: `descriptor is not null AND borough in (${quoteList(Object.keys(BOROUGH_NAME_TO_ID))}) AND complaint_type in (${quoteList(topDetailProblems)})`,
    group: ['day', 'complaint_type', 'descriptor', 'borough'],
    partitionMonths: PARTITION_MONTHS,
    select: ['date_trunc_ymd(created_date) as day', 'complaint_type', 'descriptor', 'borough', 'count(*) as n'],
    startDate: START_DATE,
  })

  const problemSeries = new Map()
  const detailSeries = new Map()

  ingestProblemRows(problemSeries, citywideProblemRows, 'citywide')
  ingestProblemRows(problemSeries, boroughProblemRows, 'borough')
  ingestProblemRows(problemSeries, boardProblemRows, 'community-board')
  ingestDetailRows(detailSeries, citywideDetailRows, 'citywide')
  ingestDetailRows(detailSeries, boroughDetailRows, 'borough')

  // Each board's share of all 311 activity (every complaint type, full window). A
  // stable "how busy is this district in general" denominator so the map's
  // concentration mode can flag where a problem is over-represented rather than just
  // where the city is dense.
  const boardActivityShares = computeBoardActivityShares(boardProblemRows)

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

  const problemAlerts = selectProblemAlerts(problemEvaluations, detailIndex)
  const allAlerts = mergeGeographyDuplicates(problemAlerts).sort((left, right) => right.priority - left.priority)
  const alertRecords = allAlerts.map((evaluation) =>
    buildAlertRecord(evaluation, detailIndex, problemEvaluations, boardActivityShares),
  )

  const alertMap = new Map(alertRecords.map((alert) => [alert.id, alert]))
  const fixedHorizon = buildFixedHorizon(alertRecords)
  const mainQueue = alertRecords

  const entityIndex = buildEntityIndex(problemEvaluations, detailEvaluations, detailIndex, alertMap, boardActivityShares)

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

function resolveWindowStartDate(endDate) {
  if (WINDOW_DAYS) {
    return startOfDay(addDays(endDate, -(WINDOW_DAYS - 1)))
  }

  return startOfDay(addDays(addYears(endDate, -WINDOW_YEARS), 1))
}

async function resolveCompleteEndDate() {
  const rows = await fetchCompletenessCounts()
  const todayKey = formatDateKey(startOfDay(CURRENT_DATE))
  const candidates = rows
    .filter((row) => row.date < todayKey)
    .sort((left, right) => right.date.localeCompare(left.date))

  for (const candidate of candidates) {
    const candidateDate = parseDateKey(candidate.date)
    const weekday = candidateDate.getUTCDay()
    const olderRows = rows.filter((row) => row.date < candidate.date)
    const sameWeekdayCounts = olderRows
      .filter((row) => parseDateKey(row.date).getUTCDay() === weekday)
      .map((row) => row.count)
      .slice(0, 8)
    const baselineCounts =
      sameWeekdayCounts.length >= COMPLETENESS_MIN_PRIOR_WEEKS
        ? sameWeekdayCounts
        : olderRows.map((row) => row.count).slice(0, 28)

    if (!baselineCounts.length) {
      continue
    }

    const baseline = median(baselineCounts)
    const threshold = Math.max(COMPLETENESS_MIN_COUNT, baseline * COMPLETENESS_MIN_RATIO)

    if (candidate.count >= threshold) {
      return {
        endDate: candidateDate,
        reason: `${candidate.count} rows vs ${Math.round(threshold)} completeness threshold`,
      }
    }
  }

  const fallbackEndDate = startOfDay(addDays(CURRENT_DATE, -FALLBACK_DATA_LAG_DAYS))

  return {
    endDate: fallbackEndDate,
    reason: `fallback ${FALLBACK_DATA_LAG_DAYS} day lag; completeness preflight found no candidate`,
  }
}

async function fetchCompletenessCounts() {
  const startDate = startOfDay(addDays(CURRENT_DATE, -COMPLETENESS_LOOKBACK_DAYS))
  const endExclusive = startOfDay(addDays(CURRENT_DATE, 1))
  const params = new URLSearchParams({
    $group: 'day',
    $limit: String(COMPLETENESS_LOOKBACK_DAYS + 2),
    $order: 'day DESC',
    $select: 'date_trunc_ymd(created_date) as day, count(*) as n',
    $where: buildBaseWhere(startDate, endExclusive),
  })
  const rows = await fetchJsonWithRetry(`${SOCRATA_BASE_URL}?${params.toString()}`, 'completeness')

  return rows
    .map((row) => ({
      count: Number(row.n),
      date: row.day.slice(0, 10),
    }))
    .filter((row) => row.date && Number.isFinite(row.count))
}

async function selectTopDetailProblems(citywideProblemRows) {
  const cached = await readTopDetailCache()

  if (!cached || daysBetween(cached.baseRefreshedOn, formatDateKey(END_DATE)) >= TOP_DETAIL_REFRESH_DAYS) {
    const rows = summarizeProblemRows(citywideProblemRows, {
      days: 365,
      limit: TOP_DETAIL_PROBLEM_COUNT,
    })
    const problems = rows.map((row) => row.problem)
    await writeTopDetailCache({
      baseRefreshedOn: formatDateKey(END_DATE),
      problems,
      updatedFor: formatDateKey(END_DATE),
    })
    return problems
  }

  const recentRows = summarizeProblemRows(citywideProblemRows, {
    days: TOP_DETAIL_EXCEPTION_LOOKBACK_DAYS,
    limit: TOP_DETAIL_EXCEPTION_CANDIDATE_LIMIT,
  })
  const cachedRecentCounts = summarizeProblemCounts(citywideProblemRows, {
    days: TOP_DETAIL_EXCEPTION_LOOKBACK_DAYS,
    problems: cached.problems,
  })
  const weakestTrackedCount = Math.min(...cached.problems.map((problem) => cachedRecentCounts.get(problem) ?? 0))
  const exceptionFloor = Math.max(
    TOP_DETAIL_EXCEPTION_MIN_CALLS,
    Math.ceil(weakestTrackedCount * TOP_DETAIL_EXCEPTION_RATIO),
  )
  const exceptions = recentRows
    .filter((row) => !cached.problems.includes(row.problem) && row.count >= exceptionFloor)
    .map((row) => row.problem)
    .slice(0, TOP_DETAIL_EXCEPTION_MAX_ADDITIONS)

  if (!exceptions.length) {
    console.log(`Using cached top-detail problem list from ${cached.baseRefreshedOn}`)
    return cached.problems
  }

  const nextProblems = applyTopDetailExceptions(cached.problems, exceptions, cachedRecentCounts)
  await writeTopDetailCache({
    baseRefreshedOn: cached.baseRefreshedOn,
    problems: nextProblems,
    updatedFor: formatDateKey(END_DATE),
  })
  console.log(`Added top-detail exception problems: ${exceptions.join(', ')}`)
  return nextProblems
}

function summarizeProblemRows(rows, { days, limit }) {
  const counts = summarizeProblemCounts(rows, {
    days,
    problems: [...new Set(rows.map((row) => row.complaint_type).filter(Boolean))],
  })

  return [...counts.entries()]
    .map(([problem, count]) => ({ count, problem }))
    .sort((left, right) => right.count - left.count || left.problem.localeCompare(right.problem))
    .slice(0, limit)
}

function summarizeProblemCounts(rows, { days, problems }) {
  const problemSet = new Set(problems)
  const startDateKey = formatDateKey(addDays(END_DATE, -(days - 1)))
  const endDateKey = formatDateKey(END_DATE)
  const counts = new Map(problems.map((problem) => [problem, 0]))

  for (const row of rows) {
    const problem = row.complaint_type
    const date = row.day?.slice(0, 10)

    if (!problemSet.has(problem) || !date || date < startDateKey || date > endDateKey) {
      continue
    }

    const count = Number(row.n)

    if (!Number.isFinite(count)) {
      continue
    }

    counts.set(problem, (counts.get(problem) ?? 0) + count)
  }

  return counts
}

function applyTopDetailExceptions(cachedProblems, exceptions, cachedRecentCounts) {
  const nextProblems = [...cachedProblems]

  for (const exception of exceptions) {
    if (nextProblems.includes(exception)) {
      continue
    }

    const replaceable = nextProblems
      .map((problem, index) => ({
        count: cachedRecentCounts.get(problem) ?? 0,
        index,
      }))
      .sort((left, right) => left.count - right.count || left.index - right.index)[0]

    if (replaceable) {
      nextProblems[replaceable.index] = exception
    }
  }

  return nextProblems
}

async function readTopDetailCache() {
  try {
    const cache = JSON.parse(await readFile(TOP_DETAIL_CACHE_PATH, 'utf8'))
    validateTopDetailCache(cache)
    return cache
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

async function writeTopDetailCache(cache) {
  validateTopDetailCache(cache)
  await mkdir(path.dirname(TOP_DETAIL_CACHE_PATH), { recursive: true })
  await writeFile(TOP_DETAIL_CACHE_PATH, JSON.stringify(cache))
}

function validateTopDetailCache(cache) {
  if (!cache || typeof cache !== 'object') {
    throw new Error('Top-detail cache must be an object')
  }

  if (!isDateKey(cache.baseRefreshedOn)) {
    throw new Error('Top-detail cache is missing a valid baseRefreshedOn date')
  }

  if (!isDateKey(cache.updatedFor)) {
    throw new Error('Top-detail cache is missing a valid updatedFor date')
  }

  if (
    !Array.isArray(cache.problems) ||
    cache.problems.length !== TOP_DETAIL_PROBLEM_COUNT ||
    cache.problems.some((problem) => typeof problem !== 'string' || !problem.trim())
  ) {
    throw new Error(`Top-detail cache must contain exactly ${TOP_DETAIL_PROBLEM_COUNT} problem names`)
  }
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
    const query = {
      group,
      label: partitionLabel,
      select,
      where: buildBaseWhere(partition.startDate, partition.endExclusive, extraWhere),
    }
    const partitionRows = await fetchCachedAggregates(query, {
      read: isCacheStablePartition(partition),
      write: true,
    })

    for (const row of partitionRows) {
      rows.push(row)
    }
  }

  return rows
}

async function fetchCachedAggregates(query, cacheOptions) {
  const cachePath = aggregateCachePath(query)

  if (cacheOptions.read) {
    try {
      const cachedRows = JSON.parse(await readFile(cachePath, 'utf8'))
      console.log(`[${query.label}] cache hit ${cachedRows.length} rows`)
      return cachedRows
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  const rows = await fetchAggregates(query)

  if (cacheOptions.write) {
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify(rows))
  }

  return rows
}

async function fetchAggregates({ group, label, limit, order, select, where }) {
  const pageSize = limit ?? AGGREGATE_PAGE_SIZE
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
    const page = await fetchJsonWithRetry(`${SOCRATA_BASE_URL}?${params.toString()}`, label)

    for (const row of page) {
      rows.push(row)
    }
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

async function fetchJsonWithRetry(url, label, attempt = 0) {
  try {
    const response = await fetchWithRetry(url, label, attempt)
    return await response.json()
  } catch (error) {
    if (attempt >= 4) {
      throw error
    }

    const backoffMs = 1_000 * (attempt + 1)
    console.log(`[${label}] retry ${attempt + 1} after response read error`)
    await new Promise((resolve) => setTimeout(resolve, backoffMs))
    return fetchJsonWithRetry(url, label, attempt + 1)
  }
}

async function fetchWithRetry(url, label, attempt = 0) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SOCRATA_REQUEST_TIMEOUT_MS)
  let response

  try {
    response = await fetch(url, {
      headers: {
        'X-App-Token': SOCRATA_APP_TOKEN,
      },
      signal: controller.signal,
    })
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
  const todaySignal = buildWindowSignalFromCounts(counts, expected, 1, comparableStartIndex)
  const sevenDaySignal = buildWindowSignalFromCounts(counts, expected, 7, comparableStartIndex)
  const thirtyDaySignal = buildWindowSignalFromCounts(counts, expected, 30, comparableStartIndex)
  const quarterSignal = buildPeriodSignal(counts, expected, 'quarter', comparableStartIndex)
  const yearSignal = buildPeriodSignal(counts, expected, 'year', comparableStartIndex)

  const horizonScores = {
    today: sparse ? 0 : scoreSignal('today', todaySignal),
    '7d': scoreSignal('7d', sevenDaySignal),
    '30d': scoreSignal('30d', thirtyDaySignal),
    quarter: comparableDays >= 365 ? scoreSignal('quarter', quarterSignal) : 0,
    year: comparableDays >= 730 ? scoreSignal('year', yearSignal) : 0,
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
  const timelineExpected = dominantSignal.expectedSeries ?? expected
  const evidence = buildSignalEvidence({
    artifacts,
    comparableDays,
    deltaPct,
    dominantHorizon,
    horizonScore: horizonScores[dominantHorizon],
    impact,
    persistence,
    signal: dominantSignal,
  })
  const hasVisibleEvidence = evidence.score >= 48 && evidence.confidence >= 45
  const dominantLongHorizon = dominantHorizon === 'quarter' || dominantHorizon === 'year'
  const hasActiveEvidence = hasVisibleEvidence && (
    dominantLongHorizon
      ? horizonScores[dominantHorizon] >= LONG_HORIZON_ACTIVE_SCORE
      : horizonScores[dominantHorizon] >= 4.5 || strongSignals >= 2
  )

  if (!hasActiveEvidence) {
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
      evidence,
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
      status: 'watch',
      timeline: buildTimeline(counts, timelineExpected),
      historyTimeline: buildQuarterlyHistoryTimeline(counts, timelineExpected),
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
    evidence,
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
    timeline: buildTimeline(counts, timelineExpected),
    historyTimeline: buildQuarterlyHistoryTimeline(counts, timelineExpected),
    impact,
  })
}

function createSeriesEvaluation(input) {
  const severity = clamp(input.horizonScores[input.dominantHorizon] * 14, 0, 100)
  const impactScore = buildImpactScore(input.impact, input.deltaPct)
  const persistenceScore = clamp(input.persistence * 100, 0, 100)
  const evidenceScore = input.evidence?.score ?? buildEvidenceScore(severity, impactScore, persistenceScore)
  const confidenceScore = input.evidence?.confidence ?? 100
  const deviationSigma = computeDeviationSigma(input.rawSignal, input.direction)

  return {
    actual: input.actual,
    artifacts: input.artifacts,
    baselineLabel: baselineLabelForHorizon(input.dominantHorizon),
    comparableDays: input.comparableDays,
    comparableStart: DATE_KEYS[input.comparableStartIndex],
    counts: input.counts,
    dailyStd: input.dailyStd,
    deltaPct: round1(input.deltaPct),
    deviationSigma,
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
      confidence: confidenceScore,
      evidence: evidenceScore,
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

function buildSignalEvidence({
  artifacts,
  comparableDays,
  deltaPct,
  dominantHorizon,
  horizonScore,
  impact,
  persistence,
  signal,
}) {
  const severity = clamp(horizonScore * 14, 0, 100)
  const impactScore = buildImpactScore(impact, deltaPct)
  const persistenceScore = clamp(persistence * 100, 0, 100)
  const evidenceScore = buildEvidenceScore(severity, impactScore, persistenceScore)
  const confidenceScore = buildConfidenceScore({
    artifacts,
    comparableDays,
    comparisonCount: signal.comparisonCount,
    horizon: dominantHorizon,
  })

  return {
    confidence: confidenceScore,
    score: evidenceScore,
  }
}

function buildEvidenceScore(severity, impactScore, persistenceScore) {
  return clamp(
    severity * 0.78 +
    persistenceScore * 0.14 +
    impactScore * 0.08,
    0,
    100,
  )
}

function buildImpactScore(impact, deltaPct) {
  const relativeImpact = clamp((Math.log1p(Math.abs(deltaPct)) / Math.log1p(300)) * 100, 0, 100)
  const absoluteImpact = clamp(Math.log1p(impact) * 12, 0, 100)

  return relativeImpact * 0.65 + absoluteImpact * 0.35
}

function buildConfidenceScore({ artifacts, comparableDays, comparisonCount, horizon }) {
  const comparisonMinimums = {
    today: 60,
    '7d': 45,
    '30d': 30,
    quarter: 4,
    year: 4,
  }
  const historyMinimums = {
    today: 84,
    '7d': 180,
    '30d': 365,
    quarter: 365,
    year: 730,
  }
  const comparisonFloor = horizon === 'quarter' || horizon === 'year' ? 0.25 : 0.55
  const comparisonConfidence = typeof comparisonCount === 'number'
    ? clamp(comparisonCount / comparisonMinimums[horizon], comparisonFloor, 1)
    : 1
  const historyConfidence = clamp(comparableDays / historyMinimums[horizon], 0.6, 1)
  const artifactFactor = artifacts.reduce((factor, artifact) => {
    if (artifact === 'Panel-wide break') {
      return factor * 0.65
    }

    if (artifact === 'Possible taxonomy artifact') {
      return factor * 0.75
    }

    if (artifact === 'Limited history') {
      return horizon === 'quarter' || horizon === 'year' ? factor * 0.9 : factor
    }

    return factor
  }, 1)

  return clamp(comparisonConfidence * historyConfidence * artifactFactor * 100, 0, 100)
}

function detectComparableStart(counts) {
  const firstNonZero = counts.findIndex((value) => value > 0)

  if (firstNonZero === -1) {
    return counts.length - 1
  }

  return firstNonZero
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
      comparisonCount: 0,
      expected: 0,
      percentileScore: 0,
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
    comparisonCount: history.length,
    expected: latest.expected,
    percentileScore: 0,
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
      comparisonCount: 0,
      expected: 0,
      percentileScore: 0,
      projectedPercentile: 50,
      raw: 0,
      score: 0,
    }
  }

  const latest = standardized.at(-1)
  const history = standardized.slice(0, -1)

  return {
    actual: 0,
    comparisonCount: history.length,
    expected: 0,
    percentileScore: 0,
    projectedPercentile: 50,
    raw: latest,
    score: robustScore(latest, history),
  }
}

function buildPeriodSignal(counts, expected, periodType, comparableStartIndex) {
  const currentPeriod = getCurrentPeriodBounds(periodType)
  const startIndex = DATE_INDEX.get(currentPeriod.start)
  const endIndex = counts.length - 1

  if (startIndex === undefined || endIndex === undefined || endIndex < startIndex) {
    return {
      actual: 0,
      comparisonCount: 0,
      expected: 0,
      percentileScore: 0,
      projectedPercentile: 50,
      raw: 0,
      score: 0,
    }
  }

  const progressLength = endIndex - startIndex + 1
  const actual = sumRange(counts, startIndex, endIndex)
  const comparablePeriods = []

  for (const periodStart of listPriorComparablePeriodStarts(periodType, currentPeriod.start)) {
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
    const fullActual = sumRange(counts, periodStartIndex, priorPeriodEndIndex)
    const fullExpected = sumRange(expected, periodStartIndex, priorPeriodEndIndex)

    comparablePeriods.push({
      actual: comparableActual,
      expected: comparableExpected,
      fullActual,
      fullExpected,
    })
  }

  const comparableActuals = comparablePeriods.map((period) => period.actual)
  const aggregateBaseline = buildAggregatePeriodBaseline([...comparableActuals].reverse())
  const expectedValue = aggregateBaseline.expected
  const raw = (actual - expectedValue) / Math.sqrt(expectedValue + 1)
  const residual = actual - expectedValue
  const residualScale = buildAggregateResidualScale(aggregateBaseline.residuals, expectedValue)
  const residualScore = residual / residualScale
  const projectedPercentile = percentileRank(comparableActuals, actual)
  const percentileScore = comparablePeriods.length >= minimumProjectedComparisons(periodType)
    ? percentileExtremeness(projectedPercentile)
    : 0
  const expectedSeries = buildAggregateExpectedSeries(expected, startIndex, endIndex, expectedValue)
  const score = residualScore

  return {
    actual,
    comparisonCount: comparablePeriods.length,
    expected: expectedValue,
    expectedSeries,
    percentileScore,
    projectedPercentile,
    raw,
    score,
  }
}

function minimumProjectedComparisons(periodType) {
  return periodType === 'year' ? 4 : 4
}

function buildAggregatePeriodBaseline(values) {
  if (!values.length) {
    return {
      expected: 0,
      fitted: [],
      residuals: [],
    }
  }

  if (values.length < 3) {
    const expected = values.at(-1) ?? 0

    return {
      expected,
      fitted: values.map(() => expected),
      residuals: values.map((value) => value - expected),
    }
  }

  const slope = theilSenSlope(values)
  const xValues = values.map((_, index) => index + 1)
  const intercept = median(values.map((value, index) => value - slope * xValues[index]))
  const fitted = xValues.map((xValue) => Math.max(0, intercept + slope * xValue))
  const residuals = values.map((value, index) => value - fitted[index])
  const trendExpected = Math.max(0, intercept + slope * (values.length + 1))
  const recentExpected = values.length >= 2
    ? values.at(-1) * 0.7 + values.at(-2) * 0.3
    : values.at(-1)
  const expected = Math.max(0, trendExpected * 0.7 + recentExpected * 0.3)

  return {
    expected,
    fitted,
    residuals,
  }
}

function theilSenSlope(values) {
  const slopes = []

  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      slopes.push((values[right] - values[left]) / (right - left))
    }
  }

  return median(slopes)
}

function buildAggregateResidualScale(residuals, expectedValue) {
  const absoluteResiduals = residuals.map((value) => Math.abs(value - median(residuals)))
  const residualScale = median(absoluteResiduals) * 1.4826
  const poissonScale = Math.sqrt(expectedValue + 1)
  const practicalScale = expectedValue * 0.12

  return Math.max(1, residualScale, poissonScale, practicalScale)
}

function buildAggregateExpectedSeries(baseExpected, startIndex, endIndex, expectedTotal) {
  const nextExpected = [...baseExpected]
  const baseTotal = sumRange(baseExpected, startIndex, endIndex)
  const windowLength = endIndex - startIndex + 1

  for (let index = startIndex; index <= endIndex; index += 1) {
    const share = baseTotal > 0
      ? baseExpected[index] / baseTotal
      : 1 / Math.max(1, windowLength)

    nextExpected[index] = expectedTotal * share
  }

  return nextExpected
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

// The dominant signal's score is already a standardized deviation: for the
// daily/7d/30d windows it is a robust z-score against the history of equivalent
// trailing windows; for quarter/year it is the residual divided by a MAD-based
// scale of the same period-to-date across prior years. Both express "how many
// standard deviations above (or below) the baseline this reading sits".
function computeDeviationSigma(rawSignal, direction) {
  if (!rawSignal || !Number.isFinite(rawSignal.score)) {
    return 0
  }

  const magnitude = Math.abs(rawSignal.score)
  const signed = direction === 'down' ? -magnitude : magnitude
  return round1(signed)
}

// States what the standard deviation is measured against so the number is never
// ambiguous across horizons.
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

// Alerts are always surfaced at the problem level. Descriptor-level detail is no
// longer promoted to stand in for the problem; instead every problem alert carries
// its details as a breakdown (see buildDetails) that the UI exposes as badges and
// an in-place filter.
function selectProblemAlerts(problemEvaluations, detailIndex) {
  const alerts = []

  for (const evaluation of problemEvaluations) {
    if (evaluation.status !== 'active') {
      continue
    }

    const candidateDetails = detailIndex.get(`${evaluation.problem}|${evaluation.geography.id}`) ?? []
    evaluation.artifacts = mergeArtifacts(evaluation.artifacts, detectTaxonomyArtifact(evaluation, candidateDetails))
    evaluation.priority = finalizePriority(evaluation, problemEvaluations)

    if (evaluation.priority >= ACTIVE_PRIORITY_FLOOR) {
      alerts.push(evaluation)
    }
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
    evaluation.signal.evidence * 0.72 +
    evaluation.signal.severity * 0.07 +
    evaluation.signal.impact * 0.08 +
    evaluation.signal.persistence * 0.08 +
    evaluation.signal.breadth * 0.08 +
    evaluation.signal.specificity * 0.05 -
    evaluation.signal.artifactPenalty
  ) * (evaluation.signal.confidence / 100)
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

function buildAlertRecord(evaluation, detailIndex, problemEvaluations, boardActivityShares) {
  const map = buildDistrictMap(evaluation.problem, evaluation.dominantHorizon, problemEvaluations, boardActivityShares, evaluation.geography.id)
  const details = buildDetails(evaluation, detailIndex)
  const idBase = `${slugify(evaluation.problem)}-${evaluation.detail ? `${slugify(evaluation.detail)}-` : ''}${evaluation.geography.id}-${evaluation.dominantHorizon}`
  const id = `${idBase}-${hashString(`${evaluation.seriesKey}|${evaluation.dominantHorizon}`)}`

  return {
    actual: evaluation.actual,
    artifacts: evaluation.artifacts,
    baselineLabel: evaluation.baselineLabel,
    comparabilityStart: evaluation.comparableStart,
    deltaPct: round1(evaluation.deltaPct),
    details,
    deviationSigma: evaluation.deviationSigma,
    direction: evaluation.direction,
    expected: evaluation.expected,
    geography: evaluation.geography,
    historyTimeline: evaluation.historyTimeline,
    horizon: evaluation.dominantHorizon,
    horizonScores: evaluation.horizonScores,
    id,
    map,
    problem: evaluation.problem,
    secondarySignals: evaluation.secondarySignals,
    sparkline: evaluation.sparkline,
    summary: evaluation.summary,
    surfaceLevel: evaluation.level,
    tags: evaluation.tags,
    timeline: evaluation.timeline,
    title: evaluation.title,
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

function buildEntityIndex(problemEvaluations, detailEvaluations, detailIndex, alertMap, boardActivityShares) {
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
        status: getEntityEvaluationStatus(evaluation),
      }))
    const activeRelated = related.filter((evaluation) => getEntityEvaluationStatus(evaluation) === 'active')

    entities.push({
      activeAlertCount: activeRelated.length,
      artifacts: [...new Set(related.flatMap((evaluation) => evaluation.artifacts))],
      currentStatus: activeRelated.length ? 'active' : getEntityEvaluationStatus(top),
      defaultHorizon: top.dominantHorizon,
      details: buildDetails(top, detailIndex),
      geographyBreakdown,
      historyTimeline: top.historyTimeline,
      horizonScores: maxHorizonScores(related),
      id,
      map: buildDistrictMap(problem, top.dominantHorizon, problemEvaluations, boardActivityShares),
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
        status: getEntityEvaluationStatus(evaluation),
      }))
    const activeRelated = related.filter((evaluation) => getEntityEvaluationStatus(evaluation) === 'active')
    const currentStatus = activeRelated.length ? 'active' : getEntityEvaluationStatus(top)

    entities.push({
      activeAlertCount: activeRelated.length,
      artifacts: [...new Set(related.flatMap((evaluation) => evaluation.artifacts))],
      currentStatus,
      defaultHorizon: top.dominantHorizon,
      details: buildDetails(top, detailIndex),
      geographyBreakdown,
      historyTimeline: top.historyTimeline,
      horizonScores: maxHorizonScores(related),
      id,
      map: buildDistrictMap(problem, top.dominantHorizon, problemEvaluations, boardActivityShares),
      name: detail,
      parentProblem: problem,
      sparkline: top.sparkline,
      summary: `${detail} is on ${currentStatus} within ${problem}, led by ${top.geography.shortLabel}.`,
      timeline: top.timeline,
      topAlertId: findProblemAlertIdForDetail(alertMap, problem, detail, top.geography.id),
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

function findProblemAlertIdForDetail(alertMap, problem, detail, geographyId) {
  const alerts = [...alertMap.values()].filter((alert) => alert.problem === problem)
  const sameGeographyDetailAlert = alerts.find(
    (alert) =>
      alert.geography.id === geographyId &&
      alert.details.some((row) => row.name === detail),
  )
  const anyDetailAlert = alerts.find((alert) => alert.details.some((row) => row.name === detail))
  const sameGeographyAlert = alerts.find((alert) => alert.geography.id === geographyId)

  return (sameGeographyDetailAlert ?? anyDetailAlert ?? sameGeographyAlert ?? alerts[0])?.id
}

function getEntityEvaluationStatus(evaluation) {
  if (evaluation.status === 'active') {
    return 'active'
  }

  if (evaluation.priority >= ACTIVE_PRIORITY_FLOOR) {
    return 'watch'
  }

  return 'quiet'
}

function buildDistrictMap(problem, horizon, problemEvaluations, boardActivityShares, selectedGeographyId) {
  const boardEvaluations = problemEvaluations.filter(
    (evaluation) => evaluation.problem === problem && evaluation.geography.type === 'community-board',
  )
  const byGeographyId = new Map(boardEvaluations.map((evaluation) => [evaluation.geography.id, evaluation]))

  return BOARD_DEFINITIONS.map((board) => {
    const evaluation = byGeographyId.get(board.id)
    // Use the same window the alert headline uses (period-to-date for quarter/year,
    // not a trailing full-period window) so a board's map number agrees with the
    // alert it belongs to instead of contradicting it.
    const metrics = evaluation
      ? getHorizonMetrics(evaluation.timeline, horizon)
      : { actual: 0, expected: 0 }
    const actual = roundCount(metrics.actual)
    const expected = roundCount(metrics.expected)
    // A board only carries a usable signal when we actually observed volume for
    // this problem there. Boards with no data are left neutral on the map instead
    // of being painted as if they were exactly on baseline.
    const hasData = Boolean(evaluation) && (actual > 0 || expected > 0)
    const intensity = expected > 0 ? actual / expected : actual > 0 ? 2 : 1

    return {
      borough: board.borough,
      id: board.id,
      label: board.label,
      actual,
      // Share of all 311 activity this board normally carries — the denominator the
      // map's concentration mode divides by.
      activityShare: round4(boardActivityShares.get(board.id) ?? 0),
      code: board.code,
      expected,
      hasData,
      intensity: round2(intensity),
      isFocus: selectedGeographyId === board.id,
    }
  })
}

// Each board's fraction of all 311 calls observed in the fetched window, across
// every complaint type. Stable "general busyness" weight per district.
function computeBoardActivityShares(boardProblemRows) {
  const totals = new Map()
  let grandTotal = 0

  for (const row of boardProblemRows) {
    const boardId = parseCommunityBoard(row.community_board)?.id

    if (!boardId) {
      continue
    }

    const count = Number(row.n)

    if (!Number.isFinite(count)) {
      continue
    }

    totals.set(boardId, (totals.get(boardId) ?? 0) + count)
    grandTotal += count
  }

  if (grandTotal <= 0) {
    return new Map()
  }

  return new Map([...totals].map(([boardId, total]) => [boardId, total / grandTotal]))
}

// Build the descriptor-level breakdown that the UI renders as badges. Each detail
// is self-contained: headline numbers at the alert's horizon plus its own daily
// timeline, so the front-end can filter the alert down to a single descriptor and
// recompute the metric strip and trend chart exactly, without another fetch.
function buildDetails(evaluation, detailIndex) {
  if (evaluation.level === 'detail') {
    return []
  }

  const rows = detailIndex.get(`${evaluation.problem}|${evaluation.geography.id}`) ?? []
  const rankedRows = rows
    .map((detailEvaluation) => {
      const metrics = getHorizonMetrics(detailEvaluation.timeline, evaluation.dominantHorizon)
      const actual = roundCount(metrics.actual)
      const expected = roundCount(metrics.expected)

      return {
        actual,
        contribution: directionalContribution(metrics, evaluation.direction),
        expected,
        name: detailEvaluation.detail,
        timeline: detailEvaluation.timeline,
      }
    })
    .filter((row) => row.name)
    .sort((left, right) => {
      if (right.contribution !== left.contribution) {
        return right.contribution - left.contribution
      }

      return Math.abs(right.actual - right.expected) - Math.abs(left.actual - left.expected)
    })
  const totalContribution = rankedRows.reduce((sum, row) => sum + row.contribution, 0)

  return rankedRows
    .filter((row) => row.contribution > 0)
    .slice(0, 6)
    .map((row) => {
      const deltaPct = row.expected > 0 ? ((row.actual - row.expected) / row.expected) * 100 : 0

      return {
        actual: row.actual,
        baselineLabel: evaluation.baselineLabel,
        deltaPct: round1(deltaPct),
        deviationSigma: standardizedDeviation(row.actual, row.expected, evaluation.direction),
        direction: evaluation.direction,
        expected: row.expected,
        name: row.name,
        // Contribution to the parent excess/deficit, expressed as a share.
        share: round1((row.contribution / Math.max(1, totalContribution)) * 100),
        timeline: row.timeline,
      }
    })
}

// A simple, signed standardized deviation consistent with how the rest of the
// pipeline standardizes counts: residual over a Poisson-style scale. Used for the
// per-detail badge tooltip where a full window/period refit would be overkill.
function standardizedDeviation(actual, expected, direction) {
  const residual = actual - expected
  const sigma = residual / Math.sqrt(expected + 1)
  return round1(direction === 'down' ? -Math.abs(sigma) : Math.abs(sigma))
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
  const points = []

  for (let index = 0; index < counts.length; index += 1) {
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
  const period = describeAlertPeriod(evaluation)
  const directionText = evaluation.direction === 'up' ? 'above' : 'below'
  const comparisonText = formatComparisonText(evaluation)

  if (evaluation.dominantHorizon === 'today') {
    const supportingWindows = HORIZONS
      .filter(
        (horizon) =>
          horizon !== 'today' &&
          evaluation.horizonScores[horizon] >= 3.25,
      )
      .map(formatHorizon)

    if (supportingWindows.length) {
      return `${period} recorded ${comparisonText}. ${formatList(supportingWindows)} ${supportingWindows.length === 1 ? 'is' : 'are'} elevated as well.`
    }

    return `${period} recorded ${comparisonText}.`
  }

  if (evaluation.dominantHorizon === '7d') {
    return `${period} totaled ${comparisonText}, ${directionText} the expected level.`
  }

  if (evaluation.dominantHorizon === '30d') {
    return `${period} totaled ${comparisonText}, ${directionText} the expected level.`
  }

  if (evaluation.dominantHorizon === 'quarter') {
    return `${period} totaled ${comparisonText}, using a trend-adjusted same-season quarter-to-date baseline.`
  }

  return `${period} totaled ${comparisonText}, using a trend-adjusted year-to-date baseline.`
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
  if (
    (evaluation.dominantHorizon === 'quarter' || evaluation.dominantHorizon === 'year') &&
    evaluation.projectedPercentile !== undefined &&
    (evaluation.projectedPercentile <= 5 || evaluation.projectedPercentile >= 95)
  ) {
    return `${formatHorizon(evaluation.dominantHorizon)} is elevated after accounting for recent same-period trend.`
  }

  const strongSignals = HORIZONS.filter((horizon) => evaluation.horizonScores[horizon] >= 3.5)

  if (strongSignals.length >= 2) {
    return `${formatHorizon(evaluation.dominantHorizon)} is most elevated; ${formatList(strongSignals.filter((horizon) => horizon !== evaluation.dominantHorizon).map(formatHorizon))} ${strongSignals.length === 2 ? 'is' : 'are'} elevated too.`
  }

  return `${formatHorizon(evaluation.dominantHorizon)} is elevated relative to expected volume.`
}

function buildSecondarySignals(evaluation) {
  return HORIZONS
    .filter(
      (horizon) =>
        horizon !== evaluation.dominantHorizon &&
        evaluation.horizonScores[horizon] >= 3.25,
    )
    .map((horizon) => `${formatHorizon(horizon)} total also elevated`)
    .slice(0, 3)
}

function formatComparisonText(evaluation) {
  const actualText = formatCallCount(evaluation.actual)
  const expectedText = evaluation.expected > 0
    ? `${formatWholeNumber(evaluation.expected)} expected`
    : 'near zero expected'
  const deviationText = evaluation.expected > 0
    ? ` (${formatSignedPercent(evaluation.deltaPct)})`
    : ''

  return `${actualText}, compared with ${expectedText}${deviationText}`
}

function formatCallCount(value) {
  const count = formatWholeNumber(value)
  return `${count} ${Math.abs(value) === 1 ? 'call' : 'calls'}`
}

function formatList(values) {
  if (values.length <= 1) {
    return values[0] ?? ''
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`
  }

  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

function describeAlertPeriod(evaluation) {
  const latestDate = evaluation.timeline.at(-1)?.date ?? formatDateKey(END_DATE)

  if (evaluation.dominantHorizon === 'today') {
    return formatDisplayDate(latestDate)
  }

  if (evaluation.dominantHorizon === '7d') {
    return `The last 7 days ending ${formatDisplayDate(latestDate)}`
  }

  if (evaluation.dominantHorizon === '30d') {
    return `The last 30 days ending ${formatDisplayDate(latestDate)}`
  }

  if (evaluation.dominantHorizon === 'quarter') {
    return `Quarter to date through ${formatDisplayDate(latestDate)}`
  }

  return `Year to date through ${formatDisplayDate(latestDate)}`
}

function formatDisplayDate(dateKey) {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(parseDateKey(dateKey))
}

function formatSignedPercent(value) {
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${round1(value)}%`
}

function formatWholeNumber(value) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(value)
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
    baselineLabel: alert.baselineLabel,
    deltaPct: alert.deltaPct,
    detail: alert.detail,
    deviationSigma: alert.deviationSigma,
    direction: alert.direction,
    expected: alert.expected,
    geography: alert.geography,
    horizon: alert.horizon,
    horizonScores: alert.horizonScores,
    id: alert.id,
    problem: alert.problem,
    sparkline: alert.sparkline,
    summary: alert.summary,
    surfaceLevel: alert.surfaceLevel,
    title: alert.title,
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
      writeJson(path.join(ENTITY_OUTPUT_ROOT, `${entityFileSlug(entity.id)}.json`), entity),
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
  const cacheRefreshStart = getCacheRefreshStart()

  while (cursor < finalExclusive) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + partitionMonths, 1))
    const partition = {
      endExclusive: next < finalExclusive ? next : finalExclusive,
      startDate: cursor < startDate ? startDate : cursor,
    }

    if (partition.startDate < cacheRefreshStart && partition.endExclusive > cacheRefreshStart) {
      partitions.push({
        endExclusive: cacheRefreshStart,
        startDate: partition.startDate,
      })
      partitions.push({
        endExclusive: partition.endExclusive,
        startDate: cacheRefreshStart,
      })
    } else {
      partitions.push(partition)
    }

    cursor = next
  }

  return partitions
}

function isCacheStablePartition(partition) {
  return partition.endExclusive <= getCacheRefreshStart()
}

function getCacheRefreshStart() {
  return startOfDay(addDays(END_DATE, -(CACHE_REFRESH_LOOKBACK_DAYS - 1)))
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

function listPriorComparablePeriodStarts(periodType, currentPeriodStart) {
  const starts = []
  let cursor = parseDateKey(currentPeriodStart)

  for (;;) {
    if (periodType === 'quarter') {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear() - 1, cursor.getUTCMonth(), 1))
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

function directionalContribution(metrics, direction) {
  return direction === 'up'
    ? Math.max(0, metrics.actual - metrics.expected)
    : Math.max(0, metrics.expected - metrics.actual)
}

function getHorizonMetrics(timeline, horizon) {
  if (horizon === 'today') {
    const latest = timeline.at(-1) ?? { actual: 0, expected: 0 }
    return {
      actual: latest.actual,
      expected: latest.expected,
    }
  }

  if (horizon === '7d' || horizon === '30d') {
    const window = horizon === '7d' ? 7 : 30

    return {
      actual: sumRecentActual(timeline, window),
      expected: sumRecentExpected(timeline, window),
    }
  }

  const bounds = getCurrentPeriodBounds(horizon)
  let actual = 0
  let expected = 0

  for (const point of timeline) {
    if (point.date >= bounds.start && point.date <= bounds.end) {
      actual += point.actual
      expected += point.expected
    }
  }

  return { actual, expected }
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

function entityFileSlug(value) {
  return `${slugify(value)}-${hashString(value)}`
}

function hashString(value) {
  let hash = 2_166_136_261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }

  return (hash >>> 0).toString(36)
}

function aggregateCachePath(query) {
  const key = JSON.stringify({
    dataset: DATASET_ID,
    group: query.group,
    limit: query.limit,
    order: query.order,
    pageSize: query.limit ?? AGGREGATE_PAGE_SIZE,
    select: query.select,
    version: 1,
    where: query.where,
  })
  const hash = createHash('sha256').update(key).digest('hex')
  return path.join(AGGREGATE_CACHE_ROOT, `${hash}.json`)
}

function readRequiredEnv(...names) {
  for (const name of names) {
    const value = process.env[name]

    if (value) {
      return value
    }
  }

  throw new Error(`${names.join(' or ')} is required for authenticated NYC Open Data requests`)
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

function round4(value) {
  return Number(value.toFixed(4))
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

function addYears(date, years) {
  const next = new Date(date)
  next.setUTCFullYear(next.getUTCFullYear() + years)
  return next
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10)
}

function parseDateKey(value) {
  return new Date(`${value}T00:00:00.000Z`)
}

function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function daysBetween(startDateKey, endDateKey) {
  return Math.floor((parseDateKey(endDateKey) - parseDateKey(startDateKey)) / 86_400_000)
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
