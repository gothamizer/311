export type Horizon = 'today' | '7d' | '30d' | 'quarter' | 'year'
export type ChartHorizon = '7d' | '30d' | 'quarter' | 'year' | 'full'
export type ChartSmoothness = 'raw' | '3pt' | '7pt'

export type PaneKey = 'main' | '7d' | '30d' | 'quarter' | 'year'

export type Direction = 'up' | 'down'

export type SurfaceLevel = 'problem' | 'detail'

export type GeographyType = 'citywide' | 'borough' | 'community-board'

export type StatusTone = 'active' | 'watch' | 'quiet'

export type ArtifactFlag =
  | 'Limited history'
  | 'Possible taxonomy artifact'
  | 'Panel-wide break'

export interface DailyPoint {
  actual: number
  date: string
  expected: number
}

export interface AlertDetail {
  actual: number
  baselineLabel: string
  deltaPct: number
  deviationSigma: number
  direction: Direction
  expected: number
  name: string
  // Share of the parent alert's excess (or deficit) attributable to this detail.
  share: number
  // Self-contained daily series so the UI can filter the alert to this detail and
  // recompute the metric strip and trend chart without another fetch.
  timeline: DailyPoint[]
}

export interface Geography {
  id: string
  label: string
  shortLabel: string
  type: GeographyType
  borough?: string
}

export interface DistrictDatum {
  borough: string
  id: string
  label: string
  actual: number
  // Fraction of all 311 activity this board normally carries (across every problem),
  // used as the denominator for the map's concentration mode. May be absent on
  // older payloads, in which case concentration falls back gracefully.
  activityShare?: number
  code: string
  expected: number
  // False when no volume was observed for this problem in the board; such cells
  // render neutral instead of as if they were sitting exactly on baseline.
  hasData: boolean
  intensity: number
  isFocus: boolean
}

export interface AlertSummary {
  actual: number
  artifacts: ArtifactFlag[]
  baselineLabel: string
  deltaPct: number
  detail?: string
  deviationSigma: number
  direction: Direction
  expected: number
  geography: Geography
  horizon: Horizon
  horizonScores: Record<Horizon, number>
  id: string
  problem: string
  sparkline: number[]
  summary: string
  surfaceLevel: SurfaceLevel
  title: string
}

export interface AlertRecord extends AlertSummary {
  comparabilityStart: string
  details: AlertDetail[]
  historyTimeline: DailyPoint[]
  map: DistrictDatum[]
  tags: string[]
  timeline: DailyPoint[]
}

export interface GeographyScore {
  actual: number
  deltaPct: number
  expected: number
  geography: Geography
  priority: number
  status: StatusTone
}

export interface EntitySummary {
  activeAlertCount: number
  currentStatus: StatusTone
  defaultHorizon: Horizon
  horizonScores: Record<Horizon, number>
  id: string
  name: string
  parentProblem?: string
  sparkline: number[]
  summary: string
  topAlertId?: string
  type: SurfaceLevel
}

export interface EntityRecord extends EntitySummary {
  artifacts: ArtifactFlag[]
  details: AlertDetail[]
  geographyBreakdown: GeographyScore[]
  historyTimeline: DailyPoint[]
  map: DistrictDatum[]
  timeline: DailyPoint[]
}

export interface DashboardData {
  allAlerts: AlertSummary[]
  entities: EntitySummary[]
  fixedHorizon: Record<Exclude<PaneKey, 'main'>, AlertSummary[]>
  generatedAt: string
  lastRefresh: string
  mainQueue: AlertSummary[]
  metrics: {
    activeAlerts: number
    boardAlerts: number
    citywideAlerts: number
    flaggedAlerts: number
  }
}
