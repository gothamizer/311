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

export interface Contributor {
  actual: number
  expected: number
  name: string
  share: number
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
  code: string
  expected: number
  intensity: number
  isFocus: boolean
}

export interface SignalBreakdown {
  artifactPenalty: number
  breadth: number
  impact: number
  persistence: number
  severity: number
  specificity: number
}

export interface AlertSummary {
  actual: number
  artifacts: ArtifactFlag[]
  deltaPct: number
  detail?: string
  direction: Direction
  expected: number
  geography: Geography
  horizon: Horizon
  horizonScores: Record<Horizon, number>
  id: string
  priority: number
  problem: string
  projectedPercentile?: number
  sparkline: number[]
  summary: string
  surfaceLevel: SurfaceLevel
  title: string
}

export interface AlertRecord extends AlertSummary {
  comparabilityStart: string
  contributors: Contributor[]
  historyTimeline: DailyPoint[]
  map: DistrictDatum[]
  queueReason: string
  secondarySignals: string[]
  signal: SignalBreakdown
  tags: string[]
  timeline: DailyPoint[]
  whyItMatters: string
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
  contributors: Contributor[]
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
