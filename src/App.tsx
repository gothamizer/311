import { startTransition, useDeferredValue, useMemo, useState } from 'react'
import { LayoutGroup, motion } from 'framer-motion'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom'

import { DetailPanel } from './components/DetailPanel'
import { Sparkline } from './components/Sparkline'
import { dashboardData } from './data/dashboard'
import {
  compactSummary,
  formatCount,
  formatDelta,
  formatFullDate,
  formatHorizonLabel,
} from './lib/format'
import type { AlertRecord, EntityRecord, PaneKey } from './types'

const PANE_META: Array<{ key: PaneKey; label: string }> = [
  { key: 'main', label: 'Queue' },
  { key: '7d', label: '7D' },
  { key: '30d', label: 'MTD' },
  { key: 'quarter', label: '90D' },
  { key: 'year', label: '12M' },
]

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="8.25" cy="8.25" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M11.8 11.8 16.2 16.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  )
}

function QueueRow({
  alert,
  selected,
  onSelect,
}: {
  alert: AlertRecord
  onSelect: (alertId: string) => void
  selected: boolean
}) {
  return (
    <motion.button
      layout
      className={`queue-row ${selected ? 'is-selected' : ''}`}
      type="button"
      onClick={() => onSelect(alert.id)}
    >
      <div className="queue-row__priority">{alert.priority}</div>
      <div className="queue-row__content">
        <div className="queue-row__title-line">
          <div>
            <p className="queue-row__title">{alert.title}</p>
            <p className="queue-row__context">
              {alert.detail ? `${alert.problem} / ` : ''}
              {alert.geography.label}
            </p>
          </div>
          <span className={`queue-row__horizon queue-row__horizon--${alert.horizon}`}>
            {formatHorizonLabel(alert.horizon)}
          </span>
        </div>
        <p className="queue-row__summary">{compactSummary(alert.summary, alert.horizon)}</p>
        <div className="queue-row__meta">
          <span>
            {formatCount(alert.actual)} / {formatCount(alert.expected)}
          </span>
          <span>{formatDelta(alert.deltaPct)}</span>
          {alert.artifacts.map((artifact) => (
            <span key={artifact}>{artifact}</span>
          ))}
        </div>
      </div>
      <div className="queue-row__spark-panel">
        <div className="queue-row__spark-metrics">
          <span>{formatCount(alert.actual)}</span>
          <strong>{formatDelta(alert.deltaPct)}</strong>
        </div>
        <Sparkline direction={alert.direction} values={alert.sparkline} />
      </div>
    </motion.button>
  )
}

function ExplorerRow({
  entity,
  selected,
  onSelect,
}: {
  entity: EntityRecord
  onSelect: (entityId: string) => void
  selected: boolean
}) {
  return (
    <button
      className={`explorer-row ${selected ? 'is-selected' : ''}`}
      type="button"
      onClick={() => onSelect(entity.id)}
    >
      <div>
        <p className="explorer-row__title">{entity.name}</p>
        <p className="explorer-row__sub">
          {entity.parentProblem ? `${entity.parentProblem} / ` : ''}
          {entity.currentStatus === 'active'
            ? 'active'
            : entity.currentStatus === 'watch'
              ? 'watch'
              : 'quiet'}
        </p>
      </div>
      <div className="explorer-row__metrics">
        <span>{formatHorizonLabel(entity.defaultHorizon)}</span>
        <strong>{entity.horizonScores[entity.defaultHorizon].toFixed(1)}</strong>
      </div>
    </button>
  )
}

function DashboardWorkspace() {
  const navigate = useNavigate()
  const params = useParams<{ alertId?: string; entityId?: string }>()
  const [activePane, setActivePane] = useState<PaneKey>('main')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())

  const activeRows =
    activePane === 'main'
      ? dashboardData.mainQueue
      : dashboardData.fixedHorizon[activePane]

  const selectedAlert = params.alertId
    ? dashboardData.allAlerts.find((alert) => alert.id === params.alertId)
    : undefined
  const selectedEntity = params.entityId
    ? dashboardData.entities.find((entity) => entity.id === params.entityId)
    : undefined
  const topAlert =
    selectedEntity?.topAlertId
      ? dashboardData.allAlerts.find((alert) => alert.id === selectedEntity.topAlertId)
      : undefined
  const fallbackAlert = activeRows[0] ?? dashboardData.mainQueue[0]
  const currentAlert = selectedAlert ?? fallbackAlert
  const showExplorer = Boolean(selectedEntity) || Boolean(deferredQuery)

  function openAlert(alertId: string) {
    setQuery('')
    setSearchOpen(false)
    navigate(`/alerts/${alertId}`)
  }

  function openEntity(entityId: string) {
    setSearchOpen(false)
    navigate(`/explore/${encodeURIComponent(entityId)}`)
  }

  function changePane(nextPane: PaneKey) {
    startTransition(() => setActivePane(nextPane))

    const nextRows =
      nextPane === 'main'
        ? dashboardData.mainQueue
        : dashboardData.fixedHorizon[nextPane]

    if (!selectedAlert || !nextRows.some((row) => row.id === selectedAlert.id)) {
      const nextAlert = nextRows[0]

      if (nextAlert) {
        navigate(`/alerts/${nextAlert.id}`)
      }
    }
  }

  function returnToQueue() {
    setQuery('')
    setSearchOpen(false)
    navigate(`/alerts/${(selectedAlert ?? fallbackAlert).id}`)
  }

  const explorerResults = useMemo(() => {
    const seededResults = selectedEntity
      ? [
          selectedEntity,
          ...dashboardData.entities.filter((entity) => entity.id !== selectedEntity.id),
        ]
      : dashboardData.entities

    if (!deferredQuery) {
      return seededResults.slice(0, 18)
    }

    return seededResults
      .filter((entity) => {
        const haystack = `${entity.name} ${entity.parentProblem ?? ''}`.toLowerCase()
        return haystack.includes(deferredQuery)
      })
      .slice(0, 18)
  }, [deferredQuery, selectedEntity])

  const queueSelectedId = selectedAlert?.id ?? fallbackAlert?.id
  const explorerSelectedId = selectedEntity?.id
  const showSearchPanel = searchOpen || Boolean(query)

  return (
    <div className="app-shell">
      <main className="workspace-grid">
        <section className="worklist-pane">
          <header className="worklist-pane__header">
            <div className="worklist-pane__toolbar">
              {!showExplorer ? (
                <div className="queue-tabs">
                  {PANE_META.map((pane) => (
                    <button
                      key={pane.key}
                      className={`queue-tabs__tab ${activePane === pane.key ? 'is-active' : ''}`}
                      type="button"
                      onClick={() => changePane(pane.key)}
                    >
                      {pane.label}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  className="worklist-pane__return"
                  type="button"
                  onClick={returnToQueue}
                >
                  Queue
                </button>
              )}

              <div className="worklist-pane__actions">
                <span className="worklist-pane__stamp">
                  {formatFullDate(dashboardData.lastRefresh)}
                </span>
                <button
                  aria-label="Search categories"
                  className={`icon-button ${showSearchPanel ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => setSearchOpen((current) => !current)}
                >
                  <SearchIcon />
                </button>
              </div>
            </div>

            {showSearchPanel ? (
              <div className="search-popover">
                <label className="explorer-search explorer-search--popover">
                  <span className="sr-only">Search Problem or Problem Detail</span>
                  <input
                    autoFocus
                    placeholder="Jump to Problem or Problem Detail"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                {query ? (
                  <button
                    className="worklist-pane__return"
                    type="button"
                    onClick={() => setQuery('')}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="worklist-pane__inline-title">
              <p className="section-kicker">
                {showExplorer ? 'Category results' : 'Current queue'}
              </p>
              {showExplorer ? (
                <span className="worklist-pane__summary">
                  {deferredQuery ? `${explorerResults.length} matches` : 'Browse categories'}
                </span>
              ) : null}
            </div>
          </header>

          {showExplorer ? (
            <div className="explorer-list explorer-list--panel">
              {explorerResults.map((entity) => (
                <ExplorerRow
                  key={entity.id}
                  entity={entity}
                  selected={explorerSelectedId === entity.id}
                  onSelect={openEntity}
                />
              ))}
            </div>
          ) : (
            <LayoutGroup>
              <div className="queue-list" role="list">
                {activeRows.map((alert) => (
                  <QueueRow
                    key={alert.id}
                    alert={alert}
                    selected={queueSelectedId === alert.id}
                    onSelect={openAlert}
                  />
                ))}
              </div>
            </LayoutGroup>
          )}
        </section>

        <section className="detail-pane">
          {selectedEntity ? (
            <DetailPanel
              key={selectedEntity.id}
              onJumpToAlert={(alertId) => {
                setQuery('')
                setActivePane('main')
                navigate(`/alerts/${alertId}`)
              }}
              selection={{ entity: selectedEntity, kind: 'entity', topAlert }}
            />
          ) : currentAlert ? (
            <DetailPanel
              key={currentAlert.id}
              onJumpToAlert={(alertId) => {
                setQuery('')
                setActivePane('main')
                navigate(`/alerts/${alertId}`)
              }}
              selection={{ alert: currentAlert, kind: 'alert' }}
            />
          ) : null}
        </section>
      </main>
    </div>
  )
}

export default function App() {
  const firstAlert = dashboardData.mainQueue[0]

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={<Navigate replace to={`/alerts/${firstAlert.id}`} />}
        />
        <Route path="/alerts/:alertId" element={<DashboardWorkspace />} />
        <Route path="/explore/:entityId" element={<DashboardWorkspace />} />
      </Routes>
    </BrowserRouter>
  )
}
