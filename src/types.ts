export type Horizon = 'today' | '7d' | '30d' | 'quarter' | 'year'
export type ChartHorizon = '7d' | '30d' | 'quarter' | 'year' | 'full'

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

export interface AlertRecord {
  actual: number
  artifacts: ArtifactFlag[]
  comparabilityStart: string
  contributors: Contributor[]
  deltaPct: number
  direction: Direction
  expected: number
  geography: Geography
  horizon: Horizon
  horizonScores: Record<Horizon, number>
  id: string
  map: DistrictDatum[]
  priority: number
  problem: string
  projectedPercentile?: number
  queueReason: string
  secondarySignals: string[]
  signal: SignalBreakdown
  sparkline: number[]
  summary: string
  surfaceLevel: SurfaceLevel
  tags: string[]
  timeline: DailyPoint[]
  title: string
  whyItMatters: string
  detail?: string
}

export interface GeographyScore {
  actual: number
  deltaPct: number
  expected: number
  geography: Geography
  priority: number
  status: StatusTone
}

export interface EntityRecord {
  activeAlertCount: number
  artifacts: ArtifactFlag[]
  contributors: Contributor[]
  currentStatus: StatusTone
  defaultHorizon: Horizon
  geographyBreakdown: GeographyScore[]
  horizonScores: Record<Horizon, number>
  id: string
  map: DistrictDatum[]
  name: string
  parentProblem?: string
  sparkline: number[]
  summary: string
  timeline: DailyPoint[]
  topAlertId?: string
  type: SurfaceLevel
}

export interface DashboardData {
  allAlerts: AlertRecord[]
  entities: EntityRecord[]
  fixedHorizon: Record<Exclude<PaneKey, 'main'>, AlertRecord[]>
  generatedAt: string
  lastRefresh: string
  mainQueue: AlertRecord[]
  metrics: {
    activeAlerts: number
    boardAlerts: number
    citywideAlerts: number
    flaggedAlerts: number
  }
}
