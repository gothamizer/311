import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'

import {
  compactSummary,
  formatCount,
  formatDelta,
  formatHorizonLabel,
  formatPercentile,
} from '../lib/format'
import type { AlertRecord, ChartHorizon, Contributor, EntityRecord } from '../types'
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

function SignalBar({
  label,
  tone = 'default',
  value,
}: {
  label: string
  tone?: 'alert' | 'default'
  value: number
}) {
  return (
    <div className="signal-bar">
      <div className="signal-bar__label-row">
        <span>{label}</span>
        <strong>{Math.round(value)}</strong>
      </div>
      <div className="signal-bar__track">
        <div
          className={`signal-bar__fill signal-bar__fill--${tone}`}
          style={{ width: `${Math.max(6, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  )
}

export function DetailPanel({
  onJumpToAlert,
  selection,
}: DetailPanelProps) {
  const entity = selection.kind === 'entity' ? selection.entity : undefined
  const alert = selection.kind === 'alert' ? selection.alert : selection.topAlert
  const selectionKey = selection.kind === 'alert' ? selection.alert.id : selection.entity.id
  const baseHorizon =
    selection.kind === 'alert'
      ? selection.alert.horizon
      : selection.entity.defaultHorizon
  const defaultChartHorizon = getDefaultChartHorizon(baseHorizon)
  const stateFallback = {
    horizon: defaultChartHorizon,
    selectionKey,
    stackPeriods:
      defaultChartHorizon === 'quarter' || defaultChartHorizon === 'year',
  }
  const [chartState, setChartState] = useState(stateFallback)
  const effectiveChartState =
    chartState.selectionKey === selectionKey ? chartState : stateFallback
  const chartHorizon = effectiveChartState.horizon
  const stackPeriods = effectiveChartState.stackPeriods
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
  const direction = alert?.direction ?? 'up'
  const timeline = alert?.timeline ?? entity?.timeline ?? []
  const map = alert?.map ?? entity?.map ?? []
  const contributors: Contributor[] = alert?.contributors ?? entity?.contributors ?? []
  const activeArtifacts =
    selection.kind === 'alert'
      ? selection.alert.artifacts
      : entity?.artifacts ?? []

  return (
    <AnimatePresence mode="wait">
      <motion.section
        key={selection.kind === 'alert' ? selection.alert.id : selection.entity.id}
        animate={{ opacity: 1, y: 0 }}
        className="detail-panel"
        exit={{ opacity: 0, y: 12 }}
        initial={{ opacity: 0, y: 18 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="detail-panel__headline">
          <div>
            <p className="detail-panel__breadcrumb">
              {selection.kind === 'alert'
                ? selection.alert.geography.label
                : parentLabel
                  ? `${parentLabel} / ${title}`
                  : title}
            </p>
            <div className="detail-panel__title-row">
              <h2>{title}</h2>
              <span className={`detail-panel__status detail-panel__status--${selection.kind === 'alert' ? selection.alert.direction : selection.entity.currentStatus}`}>
                {selection.kind === 'alert'
                  ? 'Active'
                  : selection.entity.currentStatus === 'active'
                    ? 'Active'
                    : selection.entity.currentStatus === 'watch'
                      ? 'Watch'
                      : 'Quiet'}
              </span>
            </div>
            <p className="detail-panel__summary">
              {selection.kind === 'alert'
                ? compactSummary(selection.alert.summary, selection.alert.horizon)
                : selection.entity.summary}
            </p>
          </div>

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

        <div className="detail-panel__metric-strip detail-panel__metric-strip--flat">
          {selection.kind === 'alert' ? (
            <>
              <div>
                <p className="metric-label">Alert</p>
                <p className="metric-figure">{formatHorizonLabel(selection.alert.horizon)}</p>
              </div>
              <div>
                <p className="metric-label">Actual</p>
                <p className="metric-figure">{formatCount(selection.alert.actual)}</p>
              </div>
              <div>
                <p className="metric-label">Expected</p>
                <p className="metric-figure">{formatCount(selection.alert.expected)}</p>
              </div>
              <div>
                <p className="metric-label">Deviation</p>
                <p className="metric-figure">{formatDelta(selection.alert.deltaPct)}</p>
              </div>
              <div>
                <p className="metric-label">Priority</p>
                <p className="metric-figure">{selection.alert.priority}</p>
              </div>
              <div>
                <p className="metric-label">Historic rank</p>
                <p className="metric-figure">
                  {selection.alert.projectedPercentile
                    ? formatPercentile(selection.alert.projectedPercentile)
                    : 'n/a'}
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <p className="metric-label">Current status</p>
                <p className="metric-figure">
                  {selection.entity.currentStatus === 'active'
                    ? 'Active'
                    : selection.entity.currentStatus === 'watch'
                      ? 'Watch'
                      : 'Quiet'}
                </p>
              </div>
              <div>
                <p className="metric-label">Active geographies</p>
                <p className="metric-figure">{selection.entity.activeAlertCount}</p>
              </div>
              <div>
                <p className="metric-label">Dominant horizon</p>
                <p className="metric-figure">
                  {formatHorizonLabel(baseHorizon)}
                </p>
              </div>
              <div>
                <p className="metric-label">Strongest score</p>
                <p className="metric-figure">
                  {selection.entity.horizonScores[baseHorizon].toFixed(1)}
                </p>
              </div>
            </>
          )}
        </div>

        <div className="detail-panel__controls">
          <div className="control-group__buttons">
            {([
              ['7d', '7D'],
              ['30d', '30D'],
              ['quarter', '90D'],
              ['year', '12M'],
              ['full', 'History'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                className={`chart-control ${chartHorizon === value ? 'is-active' : ''}`}
                type="button"
                onClick={() =>
                  setChartState({
                    ...effectiveChartState,
                    horizon: value,
                    selectionKey,
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>

          {chartHorizon !== 'full' ? (
            <label className="chart-checkbox">
              <input
                checked={stackPeriods}
                type="checkbox"
                onChange={(event) =>
                  setChartState({
                    ...effectiveChartState,
                    selectionKey,
                    stackPeriods: event.target.checked,
                  })
                }
              />
              <span>Stack periods</span>
            </label>
          ) : null}
        </div>

        <TrendChart
          direction={direction === 'up' ? 'up' : 'down'}
          horizon={chartHorizon}
          points={timeline}
          stackPeriods={stackPeriods && chartHorizon !== 'full'}
        />

        <div className="detail-panel__grid">
          <DistrictMap
            direction={direction === 'up' ? 'up' : 'down'}
            districts={map}
            selectedGeographyId={selection.kind === 'alert' ? selection.alert.geography.id : undefined}
          />

          <section className="detail-section">
            <div className="detail-section__header">
              <div>
                <p className="section-kicker">Specificity</p>
                <h3 className="section-title">Leading contributors</h3>
              </div>
            </div>
            <div className="detail-table">
              <div className="detail-table__header">
                <span>Contributor</span>
                <div className="detail-table__metrics detail-table__metrics--header">
                  <span>Actual</span>
                  <span>Expected</span>
                </div>
              </div>
              {contributors.map((contributor) => (
                <div key={contributor.name} className="detail-table__row">
                  <div>
                    <p className="detail-table__title">{contributor.name}</p>
                    <p className="detail-table__sub">
                      {contributor.share}% of recent excess
                    </p>
                  </div>
                  <div className="detail-table__metrics">
                    <span>{formatCount(contributor.actual)}</span>
                    <span>{formatCount(contributor.expected)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="detail-section detail-section--stacked">
            <div className="detail-section__header">
              <div>
                <p className="section-kicker">Queue logic</p>
                <h3 className="section-title">Why this surfaced</h3>
              </div>
            </div>

            {selection.kind === 'alert' ? (
              <>
                <p className="detail-section__body">{selection.alert.whyItMatters}</p>
                <SignalBar label="Severity" tone="alert" value={selection.alert.signal.severity} />
                <SignalBar label="Impact" value={selection.alert.signal.impact} />
                <SignalBar
                  label="Persistence"
                  value={selection.alert.signal.persistence}
                />
                <SignalBar label="Breadth" value={selection.alert.signal.breadth} />
                <SignalBar
                  label="Specificity"
                  value={selection.alert.signal.specificity}
                />
                {activeArtifacts.length ? (
                  <div className="detail-section__artifact-list">
                    {activeArtifacts.map((artifact) => (
                      <p key={artifact}>{artifact}</p>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <p className="detail-section__body">
                  Search is for direct inspection. Switch horizons here, then use
                  the geography table to see where this category is strongest right now.
                </p>
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
                      <span>{entry.priority}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </section>
        </div>
      </motion.section>
    </AnimatePresence>
  )
}
