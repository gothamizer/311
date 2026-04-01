import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

import { formatCount, formatDateLabel, formatMonthYearLabel } from '../lib/format'
import type { ChartHorizon, ChartSmoothness, DailyPoint } from '../types'

interface TrendChartProps {
  direction: 'up' | 'down'
  historyPoints: DailyPoint[]
  horizon: ChartHorizon
  points: DailyPoint[]
  smoothness: ChartSmoothness
  stackPeriods: boolean
}

interface PeriodPoint {
  actual: number
  date: string
  expected: number
}

interface ChartRow {
  actual: number
  compare1?: number
  compare2?: number
  compare3?: number
  date: string
  expected: number
  slot: number
}

interface PreparedChart {
  axis: 'date' | 'month' | 'relative' | 'month-slot'
  comparisonLabels: string[]
  comparisonTotals: number[]
  rows: ChartRow[]
  totals: {
    actual: number
    expected: number
  }
}

type CompareKey = 'compare1' | 'compare2' | 'compare3'

const SMOOTHNESS_WINDOW: Record<ChartSmoothness, number> = {
  raw: 1,
  '3pt': 3,
  '7pt': 7,
}

const weekdayTick = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
})

const monthOnlyTick = new Intl.DateTimeFormat('en-US', {
  month: 'short',
})

function parseDate(value: string) {
  return new Date(`${value}T12:00:00`)
}

function toPeriodPoint(point: DailyPoint): PeriodPoint {
  return {
    actual: point.actual,
    date: point.date,
    expected: point.expected,
  }
}

function monthKey(value: string) {
  return value.slice(0, 7)
}

function aggregateMonthly(points: PeriodPoint[]) {
  const grouped = new Map<string, PeriodPoint>()

  for (const point of points) {
    const key = monthKey(point.date)
    const existing = grouped.get(key)

    if (existing) {
      existing.actual += point.actual
      existing.expected += point.expected
      existing.date = point.date
      continue
    }

    grouped.set(key, { ...point })
  }

  return Array.from(grouped.values())
}

function formatMonthRangeLabel(startDate: string, endDate: string) {
  return `${formatMonthYearLabel(startDate)}-${formatMonthYearLabel(endDate)}`
}

function sumPoints(points: PeriodPoint[]) {
  return points.reduce(
    (result, point) => ({
      actual: result.actual + point.actual,
      expected: result.expected + point.expected,
    }),
    { actual: 0, expected: 0 },
  )
}

function sliceCurrentPeriod(points: DailyPoint[], horizon: Exclude<ChartHorizon, 'full'>) {
  if (horizon === '7d') {
    return points.slice(-7).map(toPeriodPoint)
  }

  if (horizon === 'year') {
    return aggregateMonthly(points.map(toPeriodPoint)).slice(-12)
  }

  const trailingDays =
    horizon === '30d'
      ? 30
      : horizon === 'quarter'
        ? 90
        : 365

  return points.slice(-trailingDays).map(toPeriodPoint)
}

function previousWeekSets(points: DailyPoint[], currentRows: PeriodPoint[]) {
  const currentLength = currentRows.length
  const labels = ['Prev week', '2w ago', '3w ago']

  return labels.map((label, index) => {
    const endIndex = points.length - currentLength * (index + 1)
    const startIndex = Math.max(0, endIndex - currentLength)
    const rows = points.slice(startIndex, endIndex).map(toPeriodPoint)

    return { label, rows }
  })
}

function previousTrailingWindowSets(points: DailyPoint[], currentRows: PeriodPoint[], unitLabel: string) {
  const currentLength = currentRows.length

  return [1, 2, 3].map((offset) => {
    const endIndex = points.length - currentLength * offset
    const startIndex = Math.max(0, endIndex - currentLength)
    const rows = points.slice(startIndex, endIndex).map(toPeriodPoint)
    const label = offset === 1 ? `Prev ${unitLabel}` : `${offset}x ${unitLabel} ago`

    return { label, rows }
  })
}

function previousCalendarYearSets(points: DailyPoint[], finalDate: Date, currentLength: number) {
  const monthlyPoints = aggregateMonthly(points.map(toPeriodPoint))
  const currentMonthKey = monthKey(finalDate.toISOString().slice(0, 10))
  const currentEndIndex = monthlyPoints.findLastIndex((point) => monthKey(point.date) === currentMonthKey)
  const safeEndIndex = currentEndIndex >= 0 ? currentEndIndex : monthlyPoints.length - 1

  return [1, 2, 3].map((offset) => {
    const endIndex = safeEndIndex - currentLength * offset
    const startIndex = Math.max(0, endIndex - currentLength + 1)
    const rows = monthlyPoints.slice(startIndex, endIndex + 1)
    const startDate = rows[0]?.date
    const endDate = rows.at(-1)?.date

    return {
      label:
        startDate && endDate
          ? formatMonthRangeLabel(startDate, endDate)
          : `Prior year ${offset}`,
      rows,
    }
  })
}

function previousComparableSets(
  points: DailyPoint[],
  horizon: Exclude<ChartHorizon, 'full'>,
  currentRows: PeriodPoint[],
) {
  const finalDate = parseDate(points.at(-1)?.date ?? toIsoDate(new Date()))
  const currentLength = currentRows.length

  if (horizon === '7d') {
    return previousWeekSets(points, currentRows)
  }

  if (horizon === '30d') {
    return previousTrailingWindowSets(points, currentRows, '30D')
  }

  if (horizon === 'quarter') {
    return previousTrailingWindowSets(points, currentRows, 'Quarter')
  }

  return previousCalendarYearSets(points, finalDate, currentLength)
}

function currentPeriodChart(
  points: DailyPoint[],
  horizon: Exclude<ChartHorizon, 'full'>,
  stackPeriods: boolean,
): PreparedChart {
  const currentRows = sliceCurrentPeriod(points, horizon)
  const comparisonSets = stackPeriods
    ? previousComparableSets(points, horizon, currentRows)
    : []
  const totals = sumPoints(currentRows)

  return {
    axis:
      horizon === 'year'
        ? 'month-slot'
        : stackPeriods
          ? 'relative'
          : 'date',
    comparisonLabels: comparisonSets.map((set) => set.label),
    comparisonTotals: comparisonSets.map((set) => sumPoints(set.rows).actual),
    rows: currentRows.map((point, index) => ({
      actual: point.actual,
      compare1: comparisonSets[0]?.rows[index]?.actual,
      compare2: comparisonSets[1]?.rows[index]?.actual,
      compare3: comparisonSets[2]?.rows[index]?.actual,
      date: point.date,
      expected: point.expected,
      slot: index,
    })),
    totals,
  }
}

function fullHistoryChart(points: DailyPoint[]): PreparedChart {
  const latest = points.at(-1)
  return {
    axis: 'month',
    comparisonLabels: [],
    comparisonTotals: [],
    rows: points.map((point, index) => ({
      actual: point.actual,
      date: point.date,
      expected: point.expected,
      slot: index,
    })),
    totals: {
      actual: latest?.actual ?? 0,
      expected: latest?.expected ?? 0,
    },
  }
}

function prepareChart(
  points: DailyPoint[],
  historyPoints: DailyPoint[],
  horizon: ChartHorizon,
  stackPeriods: boolean,
) {
  if (horizon === 'full') {
    return fullHistoryChart(historyPoints)
  }

  return currentPeriodChart(points, horizon, stackPeriods)
}

function smoothRows(rows: ChartRow[], smoothness: ChartSmoothness) {
  const windowSize = SMOOTHNESS_WINDOW[smoothness]

  if (windowSize <= 1) {
    return rows
  }

  const radius = Math.floor(windowSize / 2)
  const numericKeys: Array<keyof Pick<ChartRow, 'actual' | 'expected' | 'compare1' | 'compare2' | 'compare3'>> = [
    'actual',
    'expected',
    'compare1',
    'compare2',
    'compare3',
  ]

  return rows.map((row, index) => {
    const nextRow: ChartRow = { ...row }
    const start = Math.max(0, index - radius)
    const end = Math.min(rows.length - 1, index + radius)

    for (const key of numericKeys) {
      let sum = 0
      let count = 0

      for (let cursor = start; cursor <= end; cursor += 1) {
        const value = rows[cursor][key]

        if (typeof value === 'number') {
          sum += value
          count += 1
        }
      }

      if (count > 0) {
        nextRow[key] = sum / count
      }
    }

    return nextRow
  })
}

function lastNumericIndex(rows: ChartRow[], key: CompareKey) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (typeof rows[index][key] === 'number') {
      return index
    }
  }

  return -1
}

function SeriesEndLabel({
  color,
  cx,
  cy,
  dx = -6,
  dy = -6,
  index,
  label,
  targetIndex,
  value,
}: {
  color: string
  cx?: number
  cy?: number
  dx?: number
  dy?: number
  index?: number
  label: string
  targetIndex: number
  value?: number
}) {
  if (
    typeof cx !== 'number'
    || typeof cy !== 'number'
    || typeof index !== 'number'
    || index !== targetIndex
    || typeof value !== 'number'
  ) {
    return null
  }

  return (
    <g>
      <circle cx={cx} cy={cy} fill={color} fillOpacity={0.92} r={1.8} />
      <text
        fill={color}
        fillOpacity={0.82}
        fontFamily="IBM Plex Sans, sans-serif"
        fontSize={10}
        letterSpacing="0.04em"
        textAnchor="end"
        x={cx + dx}
        y={cy + dy}
      >
        {label}
      </text>
    </g>
  )
}

function renderSeriesEndLabel(
  label: string,
  color: string,
  targetIndex: number,
  offsets?: {
    dx?: number
    dy?: number
  },
) {
  return function SeriesLabelRenderer(props: {
    cx?: number
    cy?: number
    index?: number
    value?: number
  }) {
    return (
      <SeriesEndLabel
        color={color}
        cx={props.cx}
        cy={props.cy}
        dx={offsets?.dx}
        dy={offsets?.dy}
        index={props.index}
        label={label}
        targetIndex={targetIndex}
        value={props.value}
      />
    )
  }
}

function formatRelativeTick(
  slotValue: number,
  horizon: Exclude<ChartHorizon, 'full'>,
  rows: ChartRow[],
) {
  const slot = Number(slotValue)
  const point = rows[slot]

  if (!point) {
    return ''
  }

  if (horizon === '7d') {
    return weekdayTick.format(parseDate(point.date))
  }

  if (horizon === '30d') {
    return `Day ${slot + 1}`
  }

  if (horizon === 'quarter') {
    return `Week ${Math.floor(slot / 7) + 1}`
  }

  return formatMonthYearLabel(point.date)
}

function formatMonthSlotTick(slotValue: number, rows: ChartRow[]) {
  const slot = Number(slotValue)
  const point = rows[slot]

  if (!point) {
    return ''
  }

  return monthOnlyTick.format(parseDate(point.date))
}

function LegendItem({
  color,
  dashed = false,
  label,
}: {
  color: string
  dashed?: boolean
  label: string
}) {
  return (
    <span className="trend-chart__legend-item">
      <span
        className={`trend-chart__swatch ${dashed ? 'is-dashed' : ''}`}
        style={{ borderTopColor: color }}
      />
      {label}
    </span>
  )
}

export function TrendChart({
  direction,
  historyPoints,
  horizon,
  points,
  smoothness,
  stackPeriods,
}: TrendChartProps) {
  const chart = prepareChart(points, historyPoints, horizon, stackPeriods)
  const chartRows = smoothRows(chart.rows, smoothness)
  const accentColor = direction === 'up' ? '#ffb04c' : '#74d1d6'
  const actualColor = 'rgba(244, 247, 252, 0.96)'
  const compare1LastIndex = lastNumericIndex(chartRows, 'compare1')
  const compare2LastIndex = lastNumericIndex(chartRows, 'compare2')
  const compare3LastIndex = lastNumericIndex(chartRows, 'compare3')
  const compare1Color = 'rgba(95, 184, 255, 0.78)'
  const compare2Color = 'rgba(120, 212, 170, 0.78)'
  const compare3Color = 'rgba(201, 128, 168, 0.74)'
  const relativeHorizon = horizon === 'full' ? undefined : horizon
  const currentStart = chart.rows[0]?.date
  const currentEnd = chart.rows.at(-1)?.date
  const currentWindowLabel =
    (stackPeriods || horizon === 'year') && currentStart && currentEnd
      ? `Current window: ${
        horizon === 'year'
          ? `${formatMonthYearLabel(currentStart)} to ${formatMonthYearLabel(currentEnd)}`
          : `${formatDateLabel(currentStart)} to ${formatDateLabel(currentEnd)}`
      }`
      : undefined

  return (
    <div className="trend-chart">
      {stackPeriods || currentWindowLabel ? (
        <div className="trend-chart__bar">
          <div className="trend-chart__legend trend-chart__legend--compare">
            {stackPeriods
              ? chart.comparisonLabels.map((label, index) => (
                  <LegendItem
                    color={
                      index === 0
                        ? compare1Color
                        : index === 1
                          ? compare2Color
                          : compare3Color
                    }
                    key={label}
                    label={label}
                  />
                ))
              : null}
          </div>
          {currentWindowLabel ? (
            <div className="trend-chart__window-label">{currentWindowLabel}</div>
          ) : null}
        </div>
      ) : null}

      <div className="trend-chart__surface">
        <ResponsiveContainer width="100%" height={316}>
          <LineChart data={chartRows} margin={{ left: -10, right: 10, top: 16, bottom: 0 }}>
            <CartesianGrid stroke="rgba(229, 233, 241, 0.08)" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey={chart.axis === 'relative' || chart.axis === 'month-slot' ? 'slot' : 'date'}
              minTickGap={
                chart.axis === 'month'
                  ? 28
                  : chart.axis === 'relative' || chart.axis === 'month-slot'
                    ? 18
                    : 20
              }
              tick={{ fill: 'rgba(225, 227, 233, 0.64)', fontSize: 11 }}
              tickFormatter={(value) =>
                chart.axis === 'month'
                  ? formatMonthYearLabel(value)
                  : chart.axis === 'month-slot'
                    ? formatMonthSlotTick(Number(value), chart.rows)
                  : chart.axis === 'relative' && relativeHorizon
                    ? formatRelativeTick(Number(value), relativeHorizon, chart.rows)
                    : formatDateLabel(value)
              }
              tickLine={false}
            />
            <YAxis
              axisLine={false}
              tick={{ fill: 'rgba(225, 227, 233, 0.64)', fontSize: 11 }}
              tickFormatter={formatCount}
              tickLine={false}
              width={58}
            />
            <Line
              activeDot={false}
              animationDuration={360}
              dataKey="actual"
              dot={
                stackPeriods
                  ? renderSeriesEndLabel('Actual', actualColor, chartRows.length - 1, {
                      dx: -6,
                      dy: 12,
                    })
                  : false
              }
              isAnimationActive
              stroke={actualColor}
              strokeWidth={2.3}
              type={smoothness === 'raw' ? 'linear' : 'monotone'}
            />
            <Line
              activeDot={false}
              animationDuration={360}
              dataKey="expected"
              dot={
                stackPeriods
                  ? renderSeriesEndLabel('Expected', accentColor, chartRows.length - 1, {
                      dx: -6,
                      dy: -8,
                    })
                  : false
              }
              isAnimationActive
              stroke={accentColor}
              strokeDasharray="5 5"
              strokeWidth={1.8}
              type={smoothness === 'raw' ? 'linear' : 'monotone'}
            />
            {stackPeriods && chartRows.some((row) => typeof row.compare1 === 'number') ? (
              <Line
                activeDot={false}
                animationDuration={360}
                dataKey="compare1"
                dot={renderSeriesEndLabel(
                  chart.comparisonLabels[0] ?? 'Prev period',
                  compare1Color,
                  compare1LastIndex,
                )}
                isAnimationActive
                stroke={compare1Color}
                strokeWidth={1.45}
                type={smoothness === 'raw' ? 'linear' : 'monotone'}
              />
            ) : null}
            {stackPeriods && chartRows.some((row) => typeof row.compare2 === 'number') ? (
              <Line
                activeDot={false}
                animationDuration={360}
                dataKey="compare2"
                dot={renderSeriesEndLabel(
                  chart.comparisonLabels[1] ?? '2 periods ago',
                  compare2Color,
                  compare2LastIndex,
                )}
                isAnimationActive
                stroke={compare2Color}
                strokeWidth={1.25}
                type={smoothness === 'raw' ? 'linear' : 'monotone'}
              />
            ) : null}
            {stackPeriods && chartRows.some((row) => typeof row.compare3 === 'number') ? (
              <Line
                activeDot={false}
                animationDuration={360}
                dataKey="compare3"
                dot={renderSeriesEndLabel(
                  chart.comparisonLabels[2] ?? '3 periods ago',
                  compare3Color,
                  compare3LastIndex,
                )}
                isAnimationActive
                stroke={compare3Color}
                strokeWidth={1.1}
                type={smoothness === 'raw' ? 'linear' : 'monotone'}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
