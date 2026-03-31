import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

import { formatCount, formatDateLabel, formatDelta } from '../lib/format'
import type { ChartHorizon, DailyPoint } from '../types'

interface TrendChartProps {
  direction: 'up' | 'down'
  horizon: ChartHorizon
  points: DailyPoint[]
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
}

interface PreparedChart {
  axis: 'date' | 'month'
  comparisonLabels: string[]
  comparisonTotals: number[]
  rows: ChartRow[]
  totals: {
    actual: number
    expected: number
  }
}

const monthTick = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: '2-digit',
})

function parseDate(value: string) {
  return new Date(`${value}T12:00:00`)
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function getStartOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function shiftYears(date: Date, years: number) {
  const next = new Date(date)
  next.setFullYear(next.getFullYear() + years)
  return next
}

function toPeriodPoint(point: DailyPoint): PeriodPoint {
  return {
    actual: point.actual,
    date: point.date,
    expected: point.expected,
  }
}

function extractWindow(points: DailyPoint[], start: Date, end: Date) {
  return points
    .filter((point) => {
      const date = parseDate(point.date)
      return date >= start && date <= end
    })
    .map(toPeriodPoint)
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
  const finalDate = parseDate(points.at(-1)?.date ?? toIsoDate(new Date()))

  if (horizon === '7d') {
    return points.slice(-7).map(toPeriodPoint)
  }

  if (horizon === '30d') {
    return extractWindow(points, getStartOfMonth(finalDate), finalDate)
  }

  const trailingDays = horizon === 'quarter' ? 90 : 365

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

function previousYearMonthSets(points: DailyPoint[], finalDate: Date, currentLength: number) {
  return [1, 2, 3].map((offset) => {
    const start = new Date(finalDate.getFullYear() - offset, finalDate.getMonth(), 1)
    const end = new Date(start)
    end.setDate(start.getDate() + currentLength)

    return {
      label: monthTick.format(start),
      rows: points
        .filter((point) => {
          const date = parseDate(point.date)
          return date >= start && date < end
        })
        .map(toPeriodPoint),
    }
  })
}

function previousTrailingYearSets(points: DailyPoint[], finalDate: Date, currentLength: number) {
  return [1, 2, 3].map((offset) => {
    const end = shiftYears(finalDate, -offset)
    const start = addDays(end, -(currentLength - 1))

    return {
      label: String(end.getFullYear()),
      rows: extractWindow(points, start, end),
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
    return previousYearMonthSets(points, finalDate, currentLength)
  }

  return previousTrailingYearSets(points, finalDate, currentLength)
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
    axis: 'date',
    comparisonLabels: comparisonSets.map((set) => set.label),
    comparisonTotals: comparisonSets.map((set) => sumPoints(set.rows).actual),
    rows: currentRows.map((point, index) => ({
      actual: point.actual,
      compare1: comparisonSets[0]?.rows[index]?.actual,
      compare2: comparisonSets[1]?.rows[index]?.actual,
      compare3: comparisonSets[2]?.rows[index]?.actual,
      date: point.date,
      expected: point.expected,
    })),
    totals,
  }
}

function fullHistoryChart(points: DailyPoint[]): PreparedChart {
  const monthlyMap = new Map<
    string,
    {
      actual: number
      expected: number
    }
  >()

  for (const point of points) {
    const date = parseDate(point.date)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    const current = monthlyMap.get(key) ?? { actual: 0, expected: 0 }

    current.actual += point.actual
    current.expected += point.expected
    monthlyMap.set(key, current)
  }

  const rows = Array.from(monthlyMap.entries()).map(([key, totals]) => ({
    actual: totals.actual,
    date: `${key}-01`,
    expected: totals.expected,
  }))
  const latest = rows.at(-1)

  return {
    axis: 'month',
    comparisonLabels: [],
    comparisonTotals: [],
    rows,
    totals: {
      actual: latest?.actual ?? 0,
      expected: latest?.expected ?? 0,
    },
  }
}

function prepareChart(points: DailyPoint[], horizon: ChartHorizon, stackPeriods: boolean) {
  if (horizon === 'full') {
    return fullHistoryChart(points)
  }

  return currentPeriodChart(points, horizon, stackPeriods)
}

function LegendItem({
  dashed = false,
  label,
  tone = 'actual',
}: {
  dashed?: boolean
  label: string
  tone?: 'actual' | 'compare' | 'expected'
}) {
  return (
    <span className="trend-chart__legend-item">
      <span
        className={`trend-chart__swatch trend-chart__swatch--${tone} ${dashed ? 'is-dashed' : ''}`}
      />
      {label}
    </span>
  )
}

function SummaryStat({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="trend-chart__stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export function TrendChart({
  direction,
  horizon,
  points,
  stackPeriods,
}: TrendChartProps) {
  const chart = prepareChart(points, horizon, stackPeriods)
  const accentColor = direction === 'up' ? '#ffb04c' : '#74d1d6'
  const latestDelta =
    ((chart.totals.actual - chart.totals.expected) / Math.max(1, chart.totals.expected)) * 100

  return (
    <div className="trend-chart">
      <div className="trend-chart__bar">
        <div className="trend-chart__legend">
          <LegendItem label="Actual" />
          <LegendItem dashed label="Expected" tone="expected" />
          {stackPeriods
            ? chart.comparisonLabels.map((label) => (
                <LegendItem key={label} label={label} tone="compare" />
              ))
            : null}
        </div>

        <div className="trend-chart__stats">
          <SummaryStat label="Actual" value={formatCount(chart.totals.actual)} />
          <SummaryStat label="Expected" value={formatCount(chart.totals.expected)} />
          <SummaryStat label="Delta" value={formatDelta(latestDelta)} />
        </div>
      </div>

      <div className="trend-chart__surface">
        <ResponsiveContainer width="100%" height={316}>
          <LineChart data={chart.rows} margin={{ left: -10, right: 10, top: 16, bottom: 0 }}>
            <CartesianGrid stroke="rgba(229, 233, 241, 0.08)" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="date"
              minTickGap={chart.axis === 'month' ? 28 : 20}
              tick={{ fill: 'rgba(225, 227, 233, 0.64)', fontSize: 11 }}
              tickFormatter={(value) =>
                chart.axis === 'month'
                  ? monthTick.format(parseDate(value))
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
              dot={false}
              isAnimationActive
              stroke="rgba(244, 247, 252, 0.96)"
              strokeWidth={2.3}
              type="linear"
            />
            <Line
              activeDot={false}
              animationDuration={360}
              dataKey="expected"
              dot={false}
              isAnimationActive
              stroke={accentColor}
              strokeDasharray="5 5"
              strokeWidth={1.8}
              type="linear"
            />
            {stackPeriods && chart.rows.some((row) => typeof row.compare1 === 'number') ? (
              <Line
                activeDot={false}
                animationDuration={360}
                dataKey="compare1"
                dot={false}
                isAnimationActive
                stroke="rgba(158, 169, 188, 0.72)"
                strokeWidth={1.45}
                type="linear"
              />
            ) : null}
            {stackPeriods && chart.rows.some((row) => typeof row.compare2 === 'number') ? (
              <Line
                activeDot={false}
                animationDuration={360}
                dataKey="compare2"
                dot={false}
                isAnimationActive
                stroke="rgba(126, 137, 156, 0.58)"
                strokeWidth={1.25}
                type="linear"
              />
            ) : null}
            {stackPeriods && chart.rows.some((row) => typeof row.compare3 === 'number') ? (
              <Line
                activeDot={false}
                animationDuration={360}
                dataKey="compare3"
                dot={false}
                isAnimationActive
                stroke="rgba(101, 111, 129, 0.48)"
                strokeWidth={1.1}
                type="linear"
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
