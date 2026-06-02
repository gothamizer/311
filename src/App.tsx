import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { LayoutGroup, motion } from 'framer-motion'
import {
  BrowserRouter,
  HashRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom'

import { DetailPanel } from './components/DetailPanel'
import { Sparkline } from './components/Sparkline'
import {
  fetchAlertDetail,
  fetchDashboardIndex,
  fetchEntityDetail,
} from './data/dashboard'
import {
  compactSummary,
  formatCount,
  formatDelta,
  formatFullDate,
  formatHorizonLabel,
} from './lib/format'
import type {
  AlertRecord,
  AlertSummary,
  DashboardData,
  EntityRecord,
  EntitySummary,
  GeographyType,
  PaneKey,
} from './types'

const PANE_META: Array<{ key: PaneKey; label: string }> = [
  { key: 'main', label: 'Queue' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'quarter', label: 'QTR' },
  { key: 'year', label: 'Year' },
]

const GEOGRAPHY_FILTERS: Array<{ key: GeographyType; label: string }> = [
  { key: 'citywide', label: 'Citywide' },
  { key: 'borough', label: 'Borough' },
  { key: 'community-board', label: 'Community Board' },
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
  alert: AlertSummary
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
  entity: EntitySummary
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

function DetailLoading({
  error,
  title,
}: {
  error?: string
  title: string
}) {
  return (
    <section className="detail-panel">
      <div className="detail-panel__headline">
        <div>
          <p className="detail-panel__breadcrumb">Loading</p>
          <div className="detail-panel__title-row">
            <h2>{title}</h2>
          </div>
          <p className="detail-panel__summary">
            {error ?? 'Loading detail payload from the generated dashboard dataset.'}
          </p>
        </div>
      </div>
    </section>
  )
}

function DashboardWorkspace({
  dashboardData,
}: {
  dashboardData: DashboardData
}) {
  const navigate = useNavigate()
  const params = useParams<{ alertId?: string; entityId?: string }>()
  const [activePane, setActivePane] = useState<PaneKey>('main')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectedGeographies, setSelectedGeographies] = useState<Set<GeographyType>>(
    () => new Set(['citywide', 'borough']),
  )
  const [alertDetails, setAlertDetails] = useState<Record<string, AlertRecord>>({})
  const [entityDetails, setEntityDetails] = useState<Record<string, EntityRecord>>({})
  const [detailError, setDetailError] = useState<string>()
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())

  const filterAlerts = useCallback(
    (alerts: AlertSummary[]) =>
      alerts.filter((alert) => selectedGeographies.has(alert.geography.type)),
    [selectedGeographies],
  )

  const activeRows = useMemo(
    () =>
      filterAlerts(
        activePane === 'main'
          ? dashboardData.mainQueue
          : dashboardData.fixedHorizon[activePane],
      ),
    [activePane, dashboardData.fixedHorizon, dashboardData.mainQueue, filterAlerts],
  )

  const selectedAlertSummary = params.alertId
    ? dashboardData.allAlerts.find((alert) => alert.id === params.alertId)
    : undefined
  const selectedEntitySummary = params.entityId
    ? dashboardData.entities.find((entity) => entity.id === params.entityId)
    : undefined
  const selectedEntity = selectedEntitySummary
    ? entityDetails[selectedEntitySummary.id]
    : undefined
  const topAlertSummary =
    selectedEntitySummary?.topAlertId
      ? dashboardData.allAlerts.find((alert) => alert.id === selectedEntitySummary.topAlertId)
      : undefined
  const topAlert = topAlertSummary ? alertDetails[topAlertSummary.id] : undefined
  const fallbackAlertSummary = activeRows[0] ?? dashboardData.mainQueue[0]
  const currentAlertSummary = selectedAlertSummary ?? fallbackAlertSummary
  const currentAlert = currentAlertSummary ? alertDetails[currentAlertSummary.id] : undefined
  const showExplorer = Boolean(selectedEntitySummary) || Boolean(deferredQuery)

  useEffect(() => {
    const targetAlertId = currentAlertSummary?.id

    if (!targetAlertId || alertDetails[targetAlertId]) {
      return
    }

    let cancelled = false

    fetchAlertDetail(targetAlertId)
      .then((detail) => {
        if (!cancelled) {
          setAlertDetails((current) => ({ ...current, [detail.id]: detail }))
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setDetailError(error.message)
        }
      })

    return () => {
      cancelled = true
    }
  }, [alertDetails, currentAlertSummary])

  useEffect(() => {
    const targetEntityId = selectedEntitySummary?.id

    if (!targetEntityId || entityDetails[targetEntityId]) {
      return
    }

    let cancelled = false

    fetchEntityDetail(targetEntityId)
      .then((detail) => {
        if (!cancelled) {
          setEntityDetails((current) => ({ ...current, [detail.id]: detail }))
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setDetailError(error.message)
        }
      })

    return () => {
      cancelled = true
    }
  }, [entityDetails, selectedEntitySummary])

  useEffect(() => {
    const targetAlertId = selectedEntitySummary?.topAlertId

    if (!targetAlertId || alertDetails[targetAlertId]) {
      return
    }

    let cancelled = false

    fetchAlertDetail(targetAlertId)
      .then((detail) => {
        if (!cancelled) {
          setAlertDetails((current) => ({ ...current, [detail.id]: detail }))
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [alertDetails, selectedEntitySummary])

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

    const nextRows = filterAlerts(
      nextPane === 'main'
        ? dashboardData.mainQueue
        : dashboardData.fixedHorizon[nextPane],
    )

    if (!selectedAlertSummary || !nextRows.some((row) => row.id === selectedAlertSummary.id)) {
      const nextAlert = nextRows[0]

      if (nextAlert) {
        navigate(`/alerts/${nextAlert.id}`)
      }
    }
  }

  function toggleGeography(geography: GeographyType) {
    setSelectedGeographies((current) => {
      const next = new Set(current)

      if (next.has(geography)) {
        if (next.size === 1) {
          return current
        }

        next.delete(geography)
      } else {
        next.add(geography)
      }

      return next
    })
  }

  function returnToQueue() {
    setQuery('')
    setSearchOpen(false)

    if (currentAlertSummary) {
      navigate(`/alerts/${currentAlertSummary.id}`)
    }
  }

  const explorerResults = useMemo(() => {
    const seededResults = selectedEntitySummary
      ? [
          selectedEntitySummary,
          ...dashboardData.entities.filter((entity) => entity.id !== selectedEntitySummary.id),
        ]
      : dashboardData.entities

    if (!deferredQuery) {
      return seededResults.slice(0, 24)
    }

    return seededResults
      .filter((entity) => {
        const haystack = `${entity.name} ${entity.parentProblem ?? ''}`.toLowerCase()
        return haystack.includes(deferredQuery)
      })
      .slice(0, 24)
  }, [dashboardData.entities, deferredQuery, selectedEntitySummary])

  const queueSelectedId = selectedAlertSummary?.id ?? fallbackAlertSummary?.id
  const explorerSelectedId = selectedEntitySummary?.id
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

            {!showExplorer ? (
              <div className="geo-filter" aria-label="Geography filters">
                {GEOGRAPHY_FILTERS.map((geography) => (
                  <button
                    key={geography.key}
                    aria-pressed={selectedGeographies.has(geography.key)}
                    className={`geo-filter__button ${selectedGeographies.has(geography.key) ? 'is-active' : ''}`}
                    title={geography.key === 'community-board' ? 'Community Board' : geography.label}
                    type="button"
                    onClick={() => toggleGeography(geography.key)}
                  >
                    {geography.label}
                  </button>
                ))}
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
              ) : activePane === 'main' ? (
                <span className="worklist-pane__summary">
                  {activeRows.length} active alerts
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
          {selectedEntitySummary ? (
            selectedEntity ? (
              <DetailPanel
                key={selectedEntity.id}
                onJumpToAlert={(alertId) => {
                  setQuery('')
                  setActivePane('main')
                  navigate(`/alerts/${alertId}`)
                }}
                selection={{ entity: selectedEntity, kind: 'entity', topAlert }}
              />
            ) : (
              <DetailLoading error={detailError} title={selectedEntitySummary.name} />
            )
          ) : currentAlertSummary ? (
            currentAlert ? (
              <DetailPanel
                key={currentAlert.id}
                onJumpToAlert={(alertId) => {
                  setQuery('')
                  setActivePane('main')
                  navigate(`/alerts/${alertId}`)
                }}
                selection={{ alert: currentAlert, kind: 'alert' }}
              />
            ) : (
              <DetailLoading error={detailError} title={currentAlertSummary.title} />
            )
          ) : null}
        </section>
      </main>
    </div>
  )
}

function IndexRedirect({
  dashboardData,
}: {
  dashboardData: DashboardData
}) {
  const firstAlert = dashboardData.mainQueue[0] ?? dashboardData.allAlerts[0]

  if (!firstAlert) {
    return <div className="app-shell" />
  }

  return <Navigate replace to={`/alerts/${firstAlert.id}`} />
}

export default function App() {
  const [dashboardData, setDashboardData] = useState<DashboardData>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false

    fetchDashboardIndex()
      .then((data) => {
        if (!cancelled) {
          setDashboardData(data)
        }
      })
      .catch((loadError: Error) => {
        if (!cancelled) {
          setError(loadError.message)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (!dashboardData) {
    return (
      <div className="app-shell">
        <main className="workspace-grid">
          <section className="worklist-pane" />
          <section className="detail-pane">
            <DetailLoading error={error} title="NYC 311 Anomaly Desk" />
          </section>
        </main>
      </div>
    )
  }

  const Router = import.meta.env.VITE_HASH_ROUTER === 'true' ? HashRouter : BrowserRouter

  return (
    <Router>
      <Routes>
        <Route path="/" element={<IndexRedirect dashboardData={dashboardData} />} />
        <Route
          path="/alerts/:alertId"
          element={<DashboardWorkspace dashboardData={dashboardData} />}
        />
        <Route
          path="/explore/:entityId"
          element={<DashboardWorkspace dashboardData={dashboardData} />}
        />
      </Routes>
    </Router>
  )
}
