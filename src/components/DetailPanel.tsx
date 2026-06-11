import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
// A floating tooltip portaled to <body> so it escapes the detail panel's scroll
// clipping and any framer-motion transform context. Carries the full descriptor name
// (chips truncate) plus the numbers and share that no longer crowd the chip face.
function DetailTip({ meta, name, pos }: { meta: string; name: string; pos: { left: number; top: number } }) {
  return createPortal(
    <div className="detail-tip" style={{ left: pos.left, top: pos.top }}>
      <span className="detail-tip__name">{name}</span>
      <span className="detail-tip__meta">{meta}</span>
    </div>,
    document.body,
  )
}

// One descriptor rendered as a clickable chip. The swatch intensity tracks the share
// of the parent excess; the exact numbers live in the hover tooltip rather than on the
// chip face.
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
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null)
  const weight = maxShare > 0 ? Math.min(1, detail.share / maxShare) : 0
  const accent =
    direction === 'up'
      ? `rgba(255, 176, 76, ${0.16 + weight * 0.62})`
      : `rgba(116, 209, 214, ${0.16 + weight * 0.62})`
  const meta = `${formatCount(detail.actual)} vs ${formatCount(detail.expected)} expected · ${formatDelta(detail.deltaPct)} · ${formatSigma(detail.deviationSigma)} ${detail.baselineLabel} · ${detail.share}% of the move`

  const showTip = (event: React.SyntheticEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setTipPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), top: rect.top - 8 })
  }

  return (
    <button
      aria-label={`${detail.name}: ${meta}`}
      aria-pressed={isActive}
      className={`detail-badge ${isActive ? 'is-active' : ''}`}
      style={{ '--badge-accent': accent } as React.CSSProperties}
      type="button"
      onBlur={() => setTipPos(null)}
      onClick={() => onToggle(detail.name)}
      onFocus={showTip}
      onMouseEnter={showTip}
      onMouseLeave={() => setTipPos(null)}
    >
      <span className="detail-badge__swatch" aria-hidden="true" />
      <span className="detail-badge__name">{detail.name}</span>
      {tipPos ? <DetailTip meta={meta} name={detail.name} pos={tipPos} /> : null}
    </button>
  )
}

// Renders descriptor chips that fill the available width, folding the lowest-volume
// remainder into an "Other (N)" chip that opens a menu of the rest. Details arrive
// volume-sorted from the build, so what spills into Other is always the least
// voluminous. A hidden measurement layer carries every chip at its natural width so
// the fit can be recomputed on resize without affecting layout.
function DetailBadgeRow({
  activeDetail,
  baseline,
  details,
  direction,
  maxShare,
  onToggle,
}: {
  activeDetail: string | undefined
  baseline: string | null
  details: AlertDetail[]
  direction: Direction
  maxShare: number
  onToggle: (name: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [visibleCount, setVisibleCount] = useState(details.length)
  const [menuPos, setMenuPos] = useState<{ left: number; maxHeight: number; top: number } | null>(null)
  const menuOpen = menuPos !== null

  const closeMenu = (returnFocus: boolean) => {
    setMenuPos(null)
    if (returnFocus) {
      triggerRef.current?.focus()
    }
  }

  // Roving keyboard navigation inside the (portaled) menu so the menu role is honest:
  // arrows move between items, Home/End jump, Enter/Space activate (native button),
  // Escape/Tab dismiss and return focus to the trigger.
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (!items.length) {
      return
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(current + 1) % items.length].focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(current - 1 + items.length) % items.length].focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0].focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1].focus()
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      closeMenu(true)
    }
  }

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const measure = measureRef.current
    if (!wrap || !measure) {
      return
    }

    const recompute = () => {
      const rawAvailable = wrap.clientWidth
      if (!rawAvailable) {
        return
      }
      const nodes = Array.from(measure.children) as HTMLElement[]
      const chipNodes = nodes.slice(0, details.length)
      const otherNode = nodes[details.length]
      const gap = parseFloat(getComputedStyle(measure).columnGap || '0') || 0
      const widthOf = (node: HTMLElement) => node.getBoundingClientRect().width
      // The baseline note shares the row, so carve out its width before fitting chips.
      const baselineWidth = baseline ? widthOf(nodes[details.length + 1]) : 0
      const available = rawAvailable - (baselineWidth ? baselineWidth + gap : 0)

      let total = 0
      chipNodes.forEach((node, index) => {
        total += widthOf(node) + (index ? gap : 0)
      })
      if (total <= available) {
        setVisibleCount(details.length)
        return
      }

      const otherWidth = widthOf(otherNode)
      let used = 0
      let count = 0
      for (let index = 0; index < chipNodes.length; index += 1) {
        const next = used + (count ? gap : 0) + widthOf(chipNodes[index])
        if (next + gap + otherWidth > available) {
          break
        }
        used = next
        count += 1
      }
      setVisibleCount(Math.max(1, count))
    }

    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(wrap)
    // The first measurement can run before IBM Plex replaces the fallback font (which
    // shifts chip widths) and before layout fully settles. Without these the count can
    // stick at a stale, too-narrow value — showing "+N" with plenty of empty room.
    const raf = requestAnimationFrame(recompute)
    let cancelled = false
    document.fonts?.ready
      .then(() => {
        if (!cancelled) {
          recompute()
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [baseline, details])

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    // Move focus into the menu so keyboard users land on the first option.
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const close = () => setMenuPos(null)
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      // The menu is portaled to <body>, so it isn't inside wrapRef — exempt it too.
      if (!wrapRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        close()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menuOpen])

  const safeCount = Math.min(visibleCount, details.length)
  const visible = details.slice(0, safeCount)
  const overflow = details.slice(safeCount)

  return (
    <div className="detail-badges__wrap" ref={wrapRef}>
      <div aria-hidden className="detail-badges__row detail-badges__measure" ref={measureRef}>
        {details.map((detail) => (
          <DetailBadge
            key={detail.name}
            detail={detail}
            direction={direction}
            isActive={false}
            maxShare={maxShare}
            onToggle={() => {}}
          />
        ))}
        <span className="detail-badge detail-badge--other">
          <span className="detail-badge__name">+99</span>
          <span className="detail-badge__caret" aria-hidden="true">▾</span>
        </span>
        {baseline ? <span className="detail-badges__baseline">{baseline}</span> : null}
      </div>

      <div className="detail-badges__row detail-badges__row--live">
        {visible.map((detail) => (
          <DetailBadge
            key={detail.name}
            detail={detail}
            direction={direction}
            isActive={detail.name === activeDetail}
            maxShare={maxShare}
            onToggle={onToggle}
          />
        ))}
        {overflow.length ? (
          <div className="detail-badges__overflow">
            <button
              ref={triggerRef}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label={`Show ${overflow.length} more drivers`}
              className={`detail-badge detail-badge--other ${menuOpen ? 'is-open' : ''}`}
              type="button"
              onClick={(event) => {
                if (menuOpen) {
                  setMenuPos(null)
                  return
                }
                const rect = event.currentTarget.getBoundingClientRect()
                const estHeight = Math.min(272, overflow.length * 32 + 12)
                const spaceBelow = window.innerHeight - rect.bottom - 8
                const spaceAbove = rect.top - 8
                const openUp = estHeight > spaceBelow && spaceAbove > spaceBelow
                setMenuPos({
                  left: Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248)),
                  maxHeight: Math.max(120, openUp ? spaceAbove : spaceBelow),
                  top: openUp
                    ? Math.max(8, rect.top - 6 - Math.min(estHeight, spaceAbove))
                    : rect.bottom + 6,
                })
              }}
            >
              <span className="detail-badge__name">+{overflow.length}</span>
              <span className="detail-badge__caret" aria-hidden="true">▾</span>
            </button>
            {menuPos
              ? createPortal(
                  <div
                    ref={menuRef}
                    className="detail-badges__menu"
                    role="menu"
                    style={{ left: menuPos.left, maxHeight: menuPos.maxHeight, top: menuPos.top }}
                    onKeyDown={onMenuKeyDown}
                  >
                    {overflow.map((detail) => (
                      <button
                        key={detail.name}
                        aria-checked={detail.name === activeDetail}
                        className={`detail-badges__menu-item ${detail.name === activeDetail ? 'is-active' : ''}`}
                        role="menuitemradio"
                        tabIndex={-1}
                        type="button"
                        onClick={() => {
                          onToggle(detail.name)
                          closeMenu(true)
                        }}
                      >
                        <span className="detail-badges__menu-name">{detail.name}</span>
                        <span className="detail-badges__menu-share">{detail.share}%</span>
                      </button>
                    ))}
                  </div>,
                  document.body,
                )
              : null}
          </div>
        ) : null}
        {baseline ? <span className="detail-badges__baseline">{baseline}</span> : null}
      </div>
    </div>
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

  // The baseline note ("vs prior weeks") rides the drivers row, right-aligned under
  // the std-dev column, instead of claiming its own line in the metric strip.
  const baselineCaption =
    selection.kind === 'alert' && headlineMetrics ? headlineMetrics.baselineLabel : null

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

        {details.length || baselineCaption ? (
          <div className="detail-badges">
            {details.length ? (
              <>
                <span className="detail-badges__label">
                  {direction === 'up' ? 'Drivers' : 'Largest declines'}
                </span>
                <DetailBadgeRow
                  activeDetail={activeDetail}
                  baseline={baselineCaption}
                  details={details}
                  direction={direction}
                  maxShare={maxShare}
                  onToggle={toggleDetail}
                />
              </>
            ) : baselineCaption ? (
              <span className="detail-badges__baseline detail-badges__baseline--solo">
                {baselineCaption}
              </span>
            ) : null}
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
