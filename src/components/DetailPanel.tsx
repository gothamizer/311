import { AnimatePresence, motion } from 'framer-motion'
import { useMemo, useState } from 'react'

import {
  compactSummary,
  formatCount,
  formatDelta,
  formatHorizonLabel,
  formatSigma,
} from '../lib/format'
import type {
  AlertDetail,
  AlertRecord,
  ChartHorizon,
  ChartSmoothness,
  DailyPoint,
  Direction,
  EntityRecord,
} from '../types'
import { DistrictMap } from './DistrictMap'
import { TrendChart } from './TrendChart'

type DetailSelection =
  | {
      alert: AlertRecord
      kind: 'alert'
    }
  | {
      entity: EntityRecord
      kind: 'entity'
      topAlert?: AlertRecord
    }

interface DetailPanelProps {
  onJumpToAlert: (alertId: string) => void
  selection: DetailSelection
}

function getDefaultChartHorizon(baseHorizon: AlertRecord['horizon'] | EntityRecord['defaultHorizon']): ChartHorizon {
  return baseHorizon === 'today' ? '7d' : baseHorizon
}

// Sane default smoothing per timeframe: none for a 7-day view (only 7 points), a
// 3-day average over a month, a 7-day average over a quarter, and none for the
// aggregated year/full views where day-based smoothing does not apply.
function getDefaultChartSmoothness(chartHorizon: ChartHorizon): ChartSmoothness {
  if (chartHorizon === '30d') {
    return '3pt'
  }

  if (chartHorizon === 'quarter') {
    return '7pt'
  }

  return 'raw'
}

// Day-based moving averages only make sense while the chart is at daily resolution.
// The year view aggregates to months and the full view to quarters, where a 3- or
// 7-day window would silently average across whole months/quarters — so the control
// is hidden and no smoothing is applied there.
function isDailyChartHorizon(horizon: ChartHorizon) {
  return horizon === '7d' || horizon === '30d' || horizon === 'quarter'
}

function getDefaultStackPeriods(chartHorizon: ChartHorizon) {
  return chartHorizon === '7d' || chartHorizon === 'year'
}

// Horizon window in days, used to total a detail's timeline so its badge numbers
// agree with the metric strip when filtered.
function horizonWindowDays(horizon: AlertRecord['horizon']) {
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

function MetricCard({
  accent,
  label,
  title,
  value,
}: {
  accent?: boolean
  label: string
  title?: string
  value: string
}) {
  return (
    <div
      className={`detail-panel__metric-card ${accent ? 'detail-panel__metric-card--accent' : ''}`}
      title={title}
    >
      <p className="metric-label">{label}</p>
      <p className="metric-figure">{value}</p>
    </div>
  )
}

// One descriptor rendered as a clickable chip. Colour intensity tracks the share of
// the parent excess so the heaviest contributors read strongest at a glance.
function DetailBadge({
  detail,
  direction,
  isActive,
  maxShare,
  onToggle,
}: {
  detail: AlertDetail
  direction: Direction
  isActive: boolean
  maxShare: number
  onToggle: (name: string) => void
}) {
  const weight = maxShare > 0 ? Math.min(1, detail.share / maxShare) : 0
  const accent =
    direction === 'up'
      ? `rgba(255, 176, 76, ${0.16 + weight * 0.62})`
      : `rgba(116, 209, 214, ${0.16 + weight * 0.62})`

  return (
    <button
      aria-pressed={isActive}
      className={`detail-badge ${isActive ? 'is-active' : ''}`}
      style={{ '--badge-accent': accent } as React.CSSProperties}
      title={`${detail.name}: ${formatCount(detail.actual)} vs ${formatCount(detail.expected)} expected · ${formatDelta(detail.deltaPct)} · ${formatSigma(detail.deviationSigma)} ${detail.baselineLabel} · ${detail.share}% of the move`}
      type="button"
      onClick={() => onToggle(detail.name)}
    >
      <span className="detail-badge__swatch" aria-hidden="true" />
      <span className="detail-badge__name">{detail.name}</span>
      <span className="detail-badge__share">{detail.share}%</span>
    </button>
  )
}

// Total a detail timeline over the alert's horizon so a filtered metric strip lines
// up with what the badge promised.
function totalsForHorizon(timeline: DailyPoint[], horizon: AlertRecord['horizon']) {
  if (horizon === 'today') {
    const latest = timeline.at(-1)
    return { actual: latest?.actual ?? 0, expected: latest?.expected ?? 0 }
  }

  const window = horizonWindowDays(horizon)
  const slice = timeline.slice(-window)
  return slice.reduce(
    (totals, point) => ({
      actual: totals.actual + point.actual,
      expected: totals.expected + point.expected,
    }),
    { actual: 0, expected: 0 },
  )
}

export function DetailPanel({
  onJumpToAlert,
  selection,
}: DetailPanelProps) {
  const entity = selection.kind === 'entity' ? selection.entity : undefined
  const alert = selection.kind === 'alert' ? selection.alert : selection.topAlert
  const baseHorizon =
    selection.kind === 'alert'
      ? selection.alert.horizon
      : selection.entity.defaultHorizon
  const defaultChartHorizon = getDefaultChartHorizon(baseHorizon)
  const defaultChartSmoothness = getDefaultChartSmoothness(defaultChartHorizon)
  const [chartHorizon, setChartHorizon] = useState(defaultChartHorizon)
  const [stackPeriods, setStackPeriods] = useState(() => getDefaultStackPeriods(defaultChartHorizon))
  const [chartSmoothness, setChartSmoothness] = useState<ChartSmoothness>(
    defaultChartSmoothness,
  )
  // The descriptor filter is scoped to a selection. Storing the selection key
  // alongside the name means navigating to a different alert / entity naturally
  // drops the filter without a reset effect.
  const [detailFilter, setDetailFilter] = useState<{ key: string; name: string }>()

  const selectionKey = selection.kind === 'alert' ? selection.alert.id : selection.entity.id
  const activeDetail = detailFilter?.key === selectionKey ? detailFilter.name : undefined

  const title =
    selection.kind === 'alert'
      ? selection.alert.title
      : entity?.name ?? ''
  const parentLabel =
    selection.kind === 'alert'
      ? selection.alert.detail
        ? selection.alert.problem
        : undefined
      : entity?.parentProblem
  const direction: Direction = alert?.direction ?? 'up'
  const baseTimeline = alert?.timeline ?? entity?.timeline ?? []
  const historyTimeline = alert?.historyTimeline ?? entity?.historyTimeline ?? []
  const map = alert?.map ?? entity?.map ?? []
  const details = useMemo<AlertDetail[]>(
    () => alert?.details ?? entity?.details ?? [],
    [alert, entity],
  )

  const activeDetailRecord = useMemo(
    () => details.find((detail) => detail.name === activeDetail),
    [activeDetail, details],
  )

  const maxShare = useMemo(
    () => details.reduce((max, detail) => Math.max(max, detail.share), 0),
    [details],
  )

  function toggleDetail(name: string) {
    setDetailFilter((current) =>
      current?.key === selectionKey && current.name === name
        ? undefined
        : { key: selectionKey, name },
    )
  }

  function clearDetail() {
    setDetailFilter(undefined)
  }

  // The timeline that drives the chart: the filtered descriptor's series when a
  // badge is active, otherwise the full alert series.
  const timeline = activeDetailRecord?.timeline ?? baseTimeline

  // Headline metrics, recomputed for the filtered descriptor when one is active.
  const headlineMetrics = useMemo(() => {
    if (selection.kind !== 'alert') {
      return undefined
    }

    if (!activeDetailRecord) {
      return {
        actual: selection.alert.actual,
        expected: selection.alert.expected,
        deltaPct: selection.alert.deltaPct,
        sigma: selection.alert.deviationSigma,
        baselineLabel: selection.alert.baselineLabel,
      }
    }

    const totals = totalsForHorizon(activeDetailRecord.timeline, selection.alert.horizon)
    return {
      actual: Math.round(totals.actual),
      expected: Math.round(totals.expected),
      deltaPct: activeDetailRecord.deltaPct,
      sigma: activeDetailRecord.deviationSigma,
      baselineLabel: activeDetailRecord.baselineLabel,
    }
  }, [activeDetailRecord, selection])

  return (
    <AnimatePresence mode="wait">
      <motion.section
        key={selectionKey}
        animate={{ opacity: 1, y: 0 }}
        className="detail-panel"
        exit={{ opacity: 0, y: 12 }}
        initial={{ opacity: 0, y: 18 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="detail-panel__headline">
          <div className="detail-panel__headline-copy">
            <div className="detail-panel__title-row">
              <h2>{title}</h2>
              <p className="detail-panel__breadcrumb">
                {selection.kind === 'alert'
                  ? selection.alert.geography.label
                  : parentLabel ?? 'Category'}
              </p>
              {selection.kind === 'entity' ? (
                <span className={`detail-panel__status detail-panel__status--${selection.entity.currentStatus}`}>
                  {selection.entity.currentStatus === 'active'
                    ? 'Active'
                    : selection.entity.currentStatus === 'watch'
                      ? 'Watch'
                      : 'Quiet'}
                </span>
              ) : null}
              {activeDetailRecord ? (
                <span className="detail-filter-chip">
                  <span className="detail-filter-chip__label">{activeDetailRecord.name}</span>
                  <button
                    aria-label={`Clear ${activeDetailRecord.name} filter`}
                    className="detail-filter-chip__clear"
                    type="button"
                    onClick={clearDetail}
                  >
                    ×
                  </button>
                </span>
              ) : null}
            </div>
            <p className="detail-panel__summary">
              {selection.kind === 'alert'
                ? compactSummary(selection.alert.summary, selection.alert.horizon)
                : selection.entity.summary}
            </p>

            {selection.kind === 'entity' && selection.entity.topAlertId ? (
              <button
                className="detail-panel__action"
                type="button"
                onClick={() => onJumpToAlert(selection.entity.topAlertId!)}
              >
                Jump to active alert
              </button>
            ) : null}
          </div>

          <div
            className={`detail-panel__metric-strip ${
              selection.kind === 'alert'
                ? 'detail-panel__metric-strip--alert'
                : 'detail-panel__metric-strip--entity'
            }`}
          >
            {selection.kind === 'alert' && headlineMetrics ? (
              <>
                <MetricCard label="Window" value={formatHorizonLabel(selection.alert.horizon)} />
                <MetricCard label="Actual" value={formatCount(headlineMetrics.actual)} />
                <MetricCard label="Expected" value={formatCount(headlineMetrics.expected)} />
                <MetricCard label="Deviation" value={formatDelta(headlineMetrics.deltaPct)} />
                <MetricCard
                  accent
                  label="Std. dev"
                  title={`Standard deviations from the baseline (${headlineMetrics.baselineLabel})`}
                  value={formatSigma(headlineMetrics.sigma)}
                />
                <p className="detail-panel__metric-caption">{headlineMetrics.baselineLabel}</p>
              </>
            ) : selection.kind === 'entity' ? (
              <>
                <MetricCard
                  label="Current status"
                  value={
                    selection.entity.currentStatus === 'active'
                      ? 'Active'
                      : selection.entity.currentStatus === 'watch'
                        ? 'Watch'
                        : 'Quiet'
                  }
                />
                <MetricCard label="Active geographies" value={String(selection.entity.activeAlertCount)} />
                <MetricCard label="Dominant horizon" value={formatHorizonLabel(baseHorizon)} />
                <MetricCard
                  label="Strongest score"
                  value={selection.entity.horizonScores[baseHorizon].toFixed(1)}
                />
              </>
            ) : null}
          </div>
        </div>

        {details.length ? (
          <div className="detail-badges">
            <span className="detail-badges__label">
              {direction === 'up' ? 'Drivers' : 'Largest declines'}
            </span>
            <div className="detail-badges__row">
              {details.map((detail) => (
                <DetailBadge
                  key={detail.name}
                  detail={detail}
                  direction={direction}
                  isActive={detail.name === activeDetail}
                  maxShare={maxShare}
                  onToggle={toggleDetail}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="detail-panel__controls">
          <div className="detail-panel__controls-row">
            <div className="detail-panel__control-group detail-panel__control-group--inline">
              <span className="detail-panel__control-label">Timeframe</span>
              {([
                ['7d', '7D'],
                ['30d', '30D'],
                ['quarter', 'Quarter'],
                ['year', 'Year'],
                ['full', 'Full'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  className={`chart-control ${chartHorizon === value ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => {
                    setChartHorizon(value)
                    setChartSmoothness(getDefaultChartSmoothness(value))
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {isDailyChartHorizon(chartHorizon) ? (
              <div className="detail-panel__control-group detail-panel__control-group--inline">
                <span className="detail-panel__control-label">Trend line</span>
                {([
                  ['raw', 'Daily'],
                  ['3pt', '3d avg'],
                  ['7pt', '7d avg'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    className={`chart-control ${chartSmoothness === value ? 'is-active' : ''}`}
                    type="button"
                    onClick={() => setChartSmoothness(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}

            {chartHorizon !== 'full' ? (
              <div className="detail-panel__control-group detail-panel__control-group--inline">
                <label className="stack-toggle">
                  <input
                    checked={stackPeriods}
                    type="checkbox"
                    onChange={(event) => setStackPeriods(event.target.checked)}
                  />
                  <span>Stack prior periods</span>
                </label>
              </div>
            ) : null}
          </div>
        </div>

        <TrendChart
          direction={direction === 'up' ? 'up' : 'down'}
          historyPoints={historyTimeline}
          horizon={chartHorizon}
          points={timeline}
          smoothness={chartSmoothness}
          stackPeriods={stackPeriods && chartHorizon !== 'full'}
        />

        <DistrictMap
          activeDetailName={activeDetailRecord?.name}
          direction={direction === 'up' ? 'up' : 'down'}
          districts={map}
          geographyType={
            selection.kind === 'alert' ? selection.alert.geography.type : 'citywide'
          }
          horizon={selection.kind === 'alert' ? selection.alert.horizon : baseHorizon}
          selectedBorough={
            selection.kind === 'alert' ? selection.alert.geography.borough : undefined
          }
          selectedGeographyId={selection.kind === 'alert' ? selection.alert.geography.id : undefined}
          subjectLabel={selection.kind === 'alert' ? selection.alert.problem : entity?.name}
        />

        {selection.kind === 'entity' ? (
          <section className="detail-section">
            <div className="detail-section__header">
              <div>
                <p className="section-kicker">Geography</p>
                <h3 className="section-title">Where this category is strongest</h3>
              </div>
            </div>
            <div className="detail-table">
              {selection.entity.geographyBreakdown.slice(0, 6).map((entry) => (
                <div key={entry.geography.id} className="detail-table__row">
                  <div>
                    <p className="detail-table__title">{entry.geography.label}</p>
                    <p className="detail-table__sub">
                      {entry.status === 'active'
                        ? 'in queue'
                        : entry.status === 'watch'
                          ? 'watch'
                          : 'quiet'}
                    </p>
                  </div>
                  <div className="detail-table__metrics">
                    <span>{formatDelta(entry.deltaPct)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </motion.section>
    </AnimatePresence>
  )
}
