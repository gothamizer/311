import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

import {
  formatCount,
  formatDateLabel,
  formatDelta,
} from '../lib/format'
import type { DailyPoint, Horizon } from '../types'

interface TrendChartProps {
  direction: 'up' | 'down'
  horizon: Horizon
  points: DailyPoint[]
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
  comparisonLabels: string[]
  descriptor: string
  emphasis?: {
    from: string
    to: string
  }
  rows: ChartRow[]
  subtitle: string
}

function parseDate(value: string) {
  return new Date(`${value}T12:00:00`)
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function getStartOfQuarter(date: Date) {
  return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1)
}

function rollingRows(points: DailyPoint[], windowSize: number, take: number) {
  const rows: ChartRow[] = []

  for (let index = windowSize - 1; index < points.length; index += 1) {
    const window = points.slice(index - windowSize + 1, index + 1)
    rows.push({
      actual: window.reduce((sum, point) => sum + point.actual, 0),
      date: points[index].date,
      expected: window.reduce((sum, point) => sum + point.expected, 0),
    })
  }

  return rows.slice(-take)
}

function trailingRows(points: DailyPoint[], horizon: Horizon): PreparedChart {
  if (horizon === 'today') {
    const rows = points.slice(-21).map((point) => ({
      actual: point.actual,
      date: point.date,
      expected: point.expected,
    }))

    return {
      comparisonLabels: [],
      descriptor: 'Daily complaints',
      emphasis: rows.at(-1) ? { from: rows.at(-1)!.date, to: rows.at(-1)!.date } : undefined,
      rows,
      subtitle: 'Last 3 weeks',
    }
  }

  if (horizon === '7d') {
    const rows = rollingRows(points, 7, 84)

    return {
      comparisonLabels: [],
      descriptor: 'Rolling 7-day total',
      emphasis:
        rows.length >= 7
          ? { from: rows.at(-7)!.date, to: rows.at(-1)!.date }
          : undefined,
      rows,
      subtitle: 'Last 12 weeks',
    }
  }

  const rows = rollingRows(points, 30, 180)

  return {
    comparisonLabels: [],
    descriptor: 'Rolling 30-day total',
    emphasis:
      rows.length >= 30
        ? { from: rows.at(-30)!.date, to: rows.at(-1)!.date }
        : undefined,
    rows,
    subtitle: 'Last 6 months',
  }
}

function periodRows(points: DailyPoint[], horizon: Extract<Horizon, 'quarter' | 'year'>): PreparedChart {
  const finalDate = parseDate(points.at(-1)?.date ?? toIsoDate(new Date()))
  const currentStart =
    horizon === 'quarter'
      ? getStartOfQuarter(finalDate)
      : new Date(finalDate.getFullYear(), 0, 1)
  const currentRows = points.filter((point) => parseDate(point.date) >= currentStart)
  const comparisonSets = [1, 2, 3].map((offset) => {
    const start =
      horizon === 'quarter'
        ? new Date(currentStart.getFullYear() - offset, currentStart.getMonth(), 1)
        : new Date(finalDate.getFullYear() - offset, 0, 1)
    const end =
      horizon === 'quarter'
        ? new Date(start.getFullYear(), start.getMonth() + 3, 1)
        : new Date(start.getFullYear() + 1, 0, 1)

    return {
      label: String(start.getFullYear()),
      rows: points.filter((point) => {
        const date = parseDate(point.date)
        return date >= start && date < end
      }),
    }
  })

  let runningActual = 0
  let runningExpected = 0
  let runningCompare1 = 0
  let runningCompare2 = 0
  let runningCompare3 = 0

  return {
    comparisonLabels: comparisonSets.map((set) => set.label),
    descriptor: 'Comparable periods',
    rows: currentRows.map((point, index) => {
      runningActual += point.actual
      runningExpected += point.expected
      runningCompare1 += comparisonSets[0]?.rows[index]?.actual ?? 0
      runningCompare2 += comparisonSets[1]?.rows[index]?.actual ?? 0
      runningCompare3 += comparisonSets[2]?.rows[index]?.actual ?? 0

      return {
        actual: runningActual,
        compare1: runningCompare1 || undefined,
        compare2: runningCompare2 || undefined,
        compare3: runningCompare3 || undefined,
        date: point.date,
        expected: runningExpected,
      }
    }),
    subtitle:
      `vs expected, ${comparisonSets.map((set) => set.label).join(', ')}`,
  }
}

function prepareRows(points: DailyPoint[], horizon: Horizon) {
  if (horizon === 'quarter' || horizon === 'year') {
    return periodRows(points, horizon)
  }

  return trailingRows(points, horizon)
}

function SummaryStat({
  muted = false,
  label,
  value,
}: {
  muted?: boolean
  label: string
  value: string
}) {
  return (
    <div className={`trend-chart__stat ${muted ? 'is-muted' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export function TrendChart({ direction, horizon, points }: TrendChartProps) {
  const chart = prepareRows(points, horizon)
  const latest = chart.rows.at(-1)
  const accentColor = direction === 'up' ? '#ffb04c' : '#74d1d6'
  const actualColor = 'rgba(244, 247, 252, 0.96)'

  if (!latest) {
    return null
  }

  const deltaPct =
    ((latest.actual - latest.expected) / Math.max(1, latest.expected)) * 100

  return (
    <div className="trend-chart">
      <div className="trend-chart__bar">
        <div className="trend-chart__descriptor">
          <span>{chart.descriptor}</span>
          <span>{chart.subtitle}</span>
        </div>

        <div className="trend-chart__stats">
          <SummaryStat label="Actual" value={formatCount(latest.actual)} />
          <SummaryStat label="Expected" value={formatCount(latest.expected)} />
          {typeof latest.compare1 === 'number' ? (
            <SummaryStat
              label={chart.comparisonLabels[0] ?? 'Previous'}
              muted
              value={formatCount(latest.compare1)}
            />
          ) : null}
          <SummaryStat label="Delta" value={formatDelta(deltaPct)} />
        </div>
      </div>

      <div className="trend-chart__surface">
        <ResponsiveContainer width="100%" height={314}>
          <LineChart data={chart.rows} margin={{ left: -10, right: 10, top: 12, bottom: 0 }}>
            <CartesianGrid stroke="rgba(229, 233, 241, 0.08)" vertical={false} />
            {chart.emphasis ? (
              <ReferenceArea
                fill={direction === 'up' ? 'rgba(255, 176, 76, 0.08)' : 'rgba(116, 209, 214, 0.09)'}
                x1={chart.emphasis.from}
                x2={chart.emphasis.to}
              />
            ) : null}
            <XAxis
              axisLine={false}
              dataKey="date"
              minTickGap={36}
              tick={{ fill: 'rgba(225, 227, 233, 0.64)', fontSize: 11 }}
              tickFormatter={formatDateLabel}
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
              animationDuration={380}
              dataKey="actual"
              dot={false}
              isAnimationActive
              name="Actual"
              stroke={actualColor}
              strokeWidth={2.3}
              type="monotone"
            />
            <Line
              activeDot={false}
              animationDuration={380}
              dataKey="expected"
              dot={false}
              isAnimationActive
              name="Expected"
              stroke={accentColor}
              strokeDasharray="5 5"
              strokeWidth={1.8}
              type="monotone"
            />
            {chart.rows.some((row) => typeof row.compare1 === 'number') ? (
              <Line
                activeDot={false}
                animationDuration={380}
                dataKey="compare1"
                dot={false}
                isAnimationActive
                name={chart.comparisonLabels[0] ?? 'Previous'}
                stroke="rgba(151, 162, 182, 0.72)"
                strokeWidth={1.6}
                type="monotone"
              />
            ) : null}
            {chart.rows.some((row) => typeof row.compare2 === 'number') ? (
              <Line
                activeDot={false}
                animationDuration={380}
                dataKey="compare2"
                dot={false}
                isAnimationActive
                name={chart.comparisonLabels[1] ?? 'Two years ago'}
                stroke="rgba(120, 131, 150, 0.56)"
                strokeWidth={1.3}
                type="monotone"
              />
            ) : null}
            {chart.rows.some((row) => typeof row.compare3 === 'number') ? (
              <Line
                activeDot={false}
                animationDuration={380}
                dataKey="compare3"
                dot={false}
                isAnimationActive
                name={chart.comparisonLabels[2] ?? 'Three years ago'}
                stroke="rgba(99, 110, 129, 0.46)"
                strokeWidth={1.15}
                type="monotone"
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
