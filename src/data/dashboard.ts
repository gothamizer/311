import { clamp } from '../lib/format'
import type {
  AlertRecord,
  ArtifactFlag,
  Contributor,
  DashboardData,
  DailyPoint,
  DistrictDatum,
  EntityRecord,
  Geography,
  GeographyScore,
  Horizon,
  SignalBreakdown,
  StatusTone,
  SurfaceLevel,
} from '../types'

const TODAY = new Date('2026-03-30T12:00:00-04:00')
const START = new Date('2024-01-01T12:00:00-05:00')

const HORIZONS: Horizon[] = ['today', '7d', '30d', 'quarter', 'year']

const ARTIFACT_PENALTIES: Record<ArtifactFlag, number> = {
  'Limited history': 10,
  'Panel-wide break': 20,
  'Possible taxonomy artifact': 15,
}

const WEEKLY_PATTERN = [0.92, 0.94, 1.01, 1.08, 1.12, 1.26, 1.14]

const BOROUGH_META = [
  { boardCount: 12, codePrefix: '1', id: 'manhattan', label: 'Manhattan', short: 'MN' },
  { boardCount: 12, codePrefix: '2', id: 'bronx', label: 'Bronx', short: 'BX' },
  { boardCount: 18, codePrefix: '3', id: 'brooklyn', label: 'Brooklyn', short: 'BK' },
  { boardCount: 14, codePrefix: '4', id: 'queens', label: 'Queens', short: 'QN' },
  { boardCount: 3, codePrefix: '5', id: 'staten-island', label: 'Staten Island', short: 'SI' },
] as const

interface DistrictDefinition {
  borough: string
  code: string
  id: string
  label: string
  shortLabel: string
}

const DISTRICT_DEFINITIONS: DistrictDefinition[] = BOROUGH_META.flatMap((borough) =>
  Array.from({ length: borough.boardCount }, (_value, index) => {
    const boardNumber = index + 1

    return {
      borough: borough.label,
      code: `${borough.codePrefix}${String(boardNumber).padStart(2, '0')}`,
      id: `${borough.id}-cb${boardNumber}`,
      label: `${borough.label} Community Board ${boardNumber}`,
      shortLabel: `${borough.short} ${boardNumber}`,
    }
  }),
)

const BOROUGHS: Geography[] = [
  { id: 'citywide', label: 'Citywide', shortLabel: 'Citywide', type: 'citywide' },
  { id: 'bronx', label: 'Bronx', shortLabel: 'Bronx', type: 'borough', borough: 'Bronx' },
  {
    id: 'brooklyn',
    label: 'Brooklyn',
    shortLabel: 'Brooklyn',
    type: 'borough',
    borough: 'Brooklyn',
  },
  {
    id: 'manhattan',
    label: 'Manhattan',
    shortLabel: 'Manhattan',
    type: 'borough',
    borough: 'Manhattan',
  },
  { id: 'queens', label: 'Queens', shortLabel: 'Queens', type: 'borough', borough: 'Queens' },
  {
    id: 'staten-island',
    label: 'Staten Island',
    shortLabel: 'Staten Island',
    type: 'borough',
    borough: 'Staten Island',
  },
]

const COMMUNITY_BOARDS: Geography[] = DISTRICT_DEFINITIONS.map((district) => ({
  borough: district.borough,
  id: district.id,
  label: district.label,
  shortLabel: district.shortLabel,
  type: 'community-board',
}))

const ALL_GEOGRAPHIES = [...BOROUGHS, ...COMMUNITY_BOARDS]

const PROBLEM_CATALOG = [
  {
    problem: 'Residential Noise',
    details: ['Loud Music/Party', 'Banging/Pounding', 'Loud Talking'],
  },
  {
    problem: 'Heat/Hot Water',
    details: ['No Heat', 'No Hot Water', 'Boiler Issue'],
  },
  {
    problem: 'Illegal Parking',
    details: ['Blocked Driveway', 'Commercial Overnight', 'Hydrant'],
  },
  {
    problem: 'Street Condition',
    details: ['Pothole', 'Cave-In', 'Guardrail Damage'],
  },
  {
    problem: 'Rodent',
    details: ['Rat Sighting', 'Rat Activity', 'Mouse Sighting'],
  },
  {
    problem: 'Water System',
    details: ['Dirty Water', 'Hydrant Leak', 'Low Pressure'],
  },
  {
    problem: 'Building Maintenance',
    details: ['Elevator', 'Door/Window', 'Plumbing'],
  },
  {
    problem: 'Homeless Street Condition',
    details: ['Encampment', 'Syringe', 'Transit Undercroft'],
  },
  {
    problem: 'Sewer',
    details: ['Catch Basin', 'Sewer Backup', 'Odor'],
  },
  {
    problem: 'Air Quality',
    details: ['Smoke', 'Idling', 'Odor'],
  },
  {
    problem: 'Sanitation Condition',
    details: ['Missed Collection', 'Overflowing Basket', 'Litter'],
  },
  {
    problem: 'Tree Damage',
    details: ['Downed Limb', 'Dead Tree', 'Root Sidewalk'],
  },
  {
    problem: 'Graffiti',
    details: ['Bridge Tagging', 'Storefront Marking', 'Transit Tagging'],
  },
]

interface Blueprint {
  artifacts?: ArtifactFlag[]
  base: number
  detail?: string
  direction?: 'up' | 'down'
  geographyId: string
  horizon: Horizon
  id: string
  intensity: number
  problem: string
  queueReason?: string
  secondarySignals?: string[]
  summary: string
  surfaceLevel?: SurfaceLevel
  tags?: string[]
  whyItMatters?: string
}

const BLUEPRINTS: Blueprint[] = [
  {
    id: 'noise-bx7-party',
    problem: 'Residential Noise',
    detail: 'Loud Music/Party',
    geographyId: 'bronx-cb7',
    horizon: '7d',
    base: 36,
    intensity: 1.62,
    summary:
      'The latest week is materially above the adjusted weekly rhythm, with the lift persisting after weekend normalization.',
    secondarySignals: ['Quarter pacing elevated'],
    tags: ['Pattern break', 'Local hotspot'],
    whyItMatters:
      'High 7-day severity is being reinforced by spillover into adjacent Bronx boards, so this reads as a real neighborhood run-up rather than one event.',
  },
  {
    id: 'heat-bronx',
    problem: 'Heat/Hot Water',
    geographyId: 'bronx',
    horizon: '30d',
    base: 126,
    intensity: 1.49,
    summary:
      'The last month has shifted into a higher regime instead of reverting after short cold-weather bursts.',
    secondarySignals: ['Today still elevated'],
    tags: ['Broad borough signal'],
    whyItMatters:
      'Volume is large enough that even a moderate severity score becomes operationally important, and the 30-day lift is concentrated in multiple Bronx boards.',
  },
  {
    id: 'rodent-citywide',
    problem: 'Rodent',
    detail: 'Rat Sighting',
    geographyId: 'citywide',
    horizon: 'quarter',
    base: 388,
    intensity: 1.36,
    summary:
      'Quarter-to-date complaints are running ahead of the seasonal quarter path and are projecting toward a top-tail finish.',
    secondarySignals: ['30-day shift confirmed'],
    tags: ['Projected top tail'],
    whyItMatters:
      'This is both broad and persistent, which makes the projected quarter-end total unusually hard to dismiss as calendar noise.',
  },
  {
    id: 'sewer-bk6-catch-basin',
    problem: 'Sewer',
    detail: 'Catch Basin',
    geographyId: 'brooklyn-cb6',
    horizon: 'today',
    base: 22,
    intensity: 2.24,
    summary:
      'Today broke cleanly above the expected band after a steady six-week baseline.',
    secondarySignals: ['7-day watch'],
    tags: ['Abrupt shock'],
    whyItMatters:
      'The point shock is large on a normally stable series, and nearby Brooklyn boards are only mildly elevated, which makes the local spike more informative.',
  },
  {
    id: 'parking-qn12',
    problem: 'Illegal Parking',
    geographyId: 'queens-cb12',
    horizon: 'today',
    base: 28,
    intensity: 1.94,
    direction: 'down',
    summary:
      'Today fell well below the expected band after a normal March pattern, suggesting an abrupt local break rather than a gradual slowdown.',
    tags: ['Sharp drop'],
    whyItMatters:
      'Negative anomalies still matter when the series usually behaves predictably, especially when the drop is isolated to one board instead of borough-wide.',
  },
  {
    id: 'air-manhattan',
    problem: 'Air Quality',
    geographyId: 'manhattan',
    horizon: '30d',
    base: 92,
    intensity: 1.41,
    summary:
      'The month-like window is holding above the expected path and no longer reads like a short-lived smoke burst.',
    secondarySignals: ['Weekly pattern flattened'],
    tags: ['Sustained regime change'],
    whyItMatters:
      'The run is broad enough to show up across Manhattan submarkets, but the borough view stays more informative than a citywide roll-up.',
  },
  {
    id: 'tree-queens',
    problem: 'Tree Damage',
    geographyId: 'queens',
    horizon: '7d',
    base: 68,
    intensity: 1.56,
    summary:
      'The last week is outpacing the expected seasonal burst and still compounding after weekend adjustment.',
    secondarySignals: ['Quarter pace elevated'],
    tags: ['Storm-adjacent'],
    whyItMatters:
      'The queue score is being driven by both breadth and impact, which is exactly the type of borough-wide run that should surface near the top.',
  },
  {
    id: 'sanitation-brooklyn',
    problem: 'Sanitation Condition',
    geographyId: 'brooklyn',
    horizon: 'year',
    base: 214,
    intensity: 1.29,
    summary:
      'Year-to-date complaints are running above the annual template and are still projecting into an unusually high finish.',
    secondarySignals: ['Quarter also elevated'],
    tags: ['Projected year extreme'],
    whyItMatters:
      'A lower daily severity can still matter when the cumulative volume is this large and the projected finish stays near the top tail of comparable years.',
  },
  {
    id: 'street-mn3',
    problem: 'Street Condition',
    geographyId: 'manhattan-cb3',
    horizon: 'quarter',
    base: 48,
    intensity: 1.47,
    summary:
      'Quarter-to-date counts are climbing above the seasonal path fast enough to threaten an extreme local quarter finish.',
    secondarySignals: ['30-day shift confirmed'],
    tags: ['Localized quarter risk'],
    whyItMatters:
      'The board-level signal is materially stronger than the borough roll-up, which makes the local view the right surface for action.',
  },
  {
    id: 'building-bx4',
    problem: 'Building Maintenance',
    geographyId: 'bronx-cb4',
    horizon: '7d',
    base: 34,
    intensity: 1.58,
    summary:
      'The latest week is elevated beyond the normal weekly pattern and has not retraced after the weekend peak.',
    secondarySignals: ['30-day watch'],
    tags: ['Board cluster'],
    whyItMatters:
      'This is a medium-volume series where persistence matters more than one-day size, and the run is long enough to warrant queue priority.',
  },
  {
    id: 'homeless-citywide',
    problem: 'Homeless Street Condition',
    geographyId: 'citywide',
    horizon: 'year',
    base: 172,
    intensity: 1.31,
    summary:
      'Year-to-date volume is sustaining above the annual template and remains on pace for an unusually high finish.',
    secondarySignals: ['Quarter also elevated'],
    tags: ['Broad city signal'],
    whyItMatters:
      'The anomaly is both broad and cumulative, so the citywide roll-up communicates the story more clearly than any one local geography.',
  },
  {
    id: 'water-si1',
    problem: 'Water System',
    geographyId: 'staten-island-cb1',
    horizon: '30d',
    base: 17,
    intensity: 1.61,
    direction: 'down',
    summary:
      'The last month is running materially below the expected baseline, not just drifting lower for a few quiet days.',
    tags: ['Quiet series break'],
    whyItMatters:
      'When a usually noisy field goes unusually quiet for a full month, it can signal intake or routing changes rather than operational improvement.',
  },
  {
    id: 'sanitation-si',
    problem: 'Sanitation Condition',
    detail: 'Missed Collection',
    geographyId: 'staten-island',
    horizon: 'today',
    base: 46,
    intensity: 1.93,
    summary:
      'Today jumped above the expected band after a stable late-March stretch.',
    secondarySignals: ['7-day watch'],
    tags: ['Single-day break'],
    whyItMatters:
      'The point shock is large enough to move borough operations immediately, and the specific detail explains most of the parent-level excess.',
  },
  {
    id: 'tree-qn14',
    problem: 'Tree Damage',
    detail: 'Downed Limb',
    geographyId: 'queens-cb14',
    horizon: '7d',
    base: 19,
    intensity: 1.88,
    summary:
      'The last week is materially above the adjusted weekly path and is not fading after the first surge.',
    secondarySignals: ['Quarter watch'],
    tags: ['Specific driver'],
    whyItMatters:
      'A single detail is explaining most of the recent excess, so surfacing the child series is more informative than a generic parent alert.',
  },
  {
    id: 'air-smoke-mn10',
    problem: 'Air Quality',
    detail: 'Smoke',
    geographyId: 'manhattan-cb10',
    horizon: 'today',
    base: 14,
    intensity: 2.3,
    summary:
      'Today is running well outside the expected band with little comparable movement elsewhere in Manhattan.',
    tags: ['Isolated spike'],
    whyItMatters:
      'The anomaly is sharp, localized, and specific, which makes it easy to understand and operationally meaningful despite the smaller base.',
  },
  {
    id: 'sewer-bk9',
    problem: 'Sewer',
    detail: 'Sewer Backup',
    geographyId: 'brooklyn-cb9',
    horizon: '30d',
    base: 26,
    intensity: 1.52,
    summary:
      'The last 30 days have shifted above the expected range and stayed there long enough to look structural.',
    secondarySignals: ['Today still elevated'],
    tags: ['Persistent local run'],
    whyItMatters:
      'The series is smaller than the citywide leaders, but the persistence and localized intensity are strong enough to demand attention.',
  },
  {
    id: 'noise-mn10',
    problem: 'Residential Noise',
    geographyId: 'manhattan-cb10',
    horizon: 'today',
    base: 31,
    intensity: 1.86,
    summary:
      'Today rose above the expected band after a normal weekly climb, suggesting an abrupt local break.',
    tags: ['Point shock'],
    whyItMatters:
      'This is the type of single-day deviation the queue should still expose when it is local, legible, and materially above the adjusted band.',
  },
  {
    id: 'heat-bx5-hot-water',
    problem: 'Heat/Hot Water',
    detail: 'No Hot Water',
    geographyId: 'bronx-cb5',
    horizon: 'today',
    base: 21,
    intensity: 2.12,
    summary:
      'Today is sharply above the expected band, with most of the parent excess explained by one detail.',
    secondarySignals: ['7-day watch'],
    tags: ['Specific driver'],
    whyItMatters:
      'The detail-level explanation is strong enough to justify surfacing the child series directly instead of a broader parent card.',
  },
  {
    id: 'homeless-bronx',
    problem: 'Homeless Street Condition',
    detail: 'Encampment',
    geographyId: 'bronx',
    horizon: 'quarter',
    base: 74,
    intensity: 1.43,
    summary:
      'Quarter-to-date counts are pacing well above the expected quarter profile and are still climbing.',
    secondarySignals: ['30-day shift confirmed'],
    tags: ['Borough quarter run'],
    whyItMatters:
      'The cumulative signal is strong, and the borough view stays more informative than citywide because the excess is not evenly distributed.',
  },
  {
    id: 'basket-manhattan',
    problem: 'Sanitation Condition',
    detail: 'Overflowing Basket',
    geographyId: 'manhattan',
    horizon: '7d',
    base: 82,
    intensity: 1.39,
    summary:
      'The latest week is running above the normal rhythm and is no longer explained by the usual weekend amplification.',
    tags: ['Weekly run'],
    whyItMatters:
      'This is a dense operational series with enough volume that even a moderate weekly shift deserves visibility.',
  },
  {
    id: 'water-qn1',
    problem: 'Water System',
    detail: 'Dirty Water',
    geographyId: 'queens-cb1',
    horizon: '30d',
    base: 18,
    intensity: 1.68,
    summary:
      'The last month has shifted above the expected range and remained there, suggesting a real service issue rather than one event.',
    secondarySignals: ['Quarter watch'],
    tags: ['Local quality issue'],
    whyItMatters:
      'The board-level series is sufficiently specific and persistent that it explains the anomaly better than a borough-level water alert.',
  },
  {
    id: 'street-brooklyn',
    problem: 'Street Condition',
    detail: 'Pothole',
    geographyId: 'brooklyn',
    horizon: 'quarter',
    base: 138,
    intensity: 1.28,
    summary:
      'Brooklyn is running ahead of the expected quarter path and is pacing toward an unusually high local finish.',
    secondarySignals: ['30-day shift confirmed'],
    tags: ['Cumulative pressure'],
    whyItMatters:
      'This is a broad borough signal with meaningful complaint volume, so the priority comes from impact as much as statistical severity.',
  },
  {
    id: 'air-citywide-idling',
    problem: 'Air Quality',
    detail: 'Idling',
    geographyId: 'citywide',
    horizon: 'year',
    base: 122,
    intensity: 1.24,
    direction: 'down',
    summary:
      'Year-to-date volume is running below the annual template and is projecting into an unusually quiet finish.',
    tags: ['Systemic drop'],
    whyItMatters:
      'The scale and breadth make a sustained negative anomaly notable, especially when it may reflect routing or compliance changes instead of a single local improvement.',
  },
  {
    id: 'rodent-bk14',
    problem: 'Rodent',
    detail: 'Rat Activity',
    geographyId: 'brooklyn-cb14',
    horizon: '30d',
    base: 24,
    intensity: 1.57,
    summary:
      'The month-like window is above the expected range and still climbing instead of normalizing.',
    secondarySignals: ['Quarter watch'],
    tags: ['Specific driver'],
    whyItMatters:
      'The anomaly stays local and detail-explained, which is exactly when the queue should choose the more specific child series.',
  },
  {
    id: 'heat-bx7-boiler',
    problem: 'Heat/Hot Water',
    detail: 'Boiler Issue',
    geographyId: 'bronx-cb7',
    horizon: '7d',
    base: 16,
    intensity: 1.95,
    summary:
      'The last week is tracking well above the weekly template and remains elevated after calendar adjustment.',
    tags: ['Specific root cause'],
    whyItMatters:
      'The child series explains most of the parent excess and stays concentrated in one local geography, so it is the cleanest surface for the alert.',
  },
  {
    id: 'sanitation-qn2',
    problem: 'Sanitation Condition',
    detail: 'Litter',
    geographyId: 'queens-cb2',
    horizon: 'year',
    base: 33,
    intensity: 1.33,
    summary:
      'Year-to-date litter complaints are still pacing above the annual path and have not mean-reverted.',
    secondarySignals: ['Quarter elevated'],
    tags: ['Long-horizon drift'],
    whyItMatters:
      'The signal is persistent enough to matter and specific enough that the detail series is more useful than the parent category.',
  },
  {
    id: 'parking-bk2',
    problem: 'Illegal Parking',
    detail: 'Blocked Driveway',
    geographyId: 'brooklyn-cb2',
    horizon: '7d',
    base: 29,
    intensity: 1.48,
    summary:
      'The last week is above the adjusted baseline and has not retraced after weekday normalization.',
    tags: ['Repeated short-run lift'],
    whyItMatters:
      'The weekly signal is sustained enough to reach the queue, and the detail series explains the local complaint burden more cleanly than the parent.',
  },
  {
    id: 'building-mn5',
    problem: 'Building Maintenance',
    detail: 'Elevator',
    geographyId: 'manhattan-cb5',
    horizon: '30d',
    base: 17,
    intensity: 1.46,
    direction: 'down',
    summary:
      'The last month is materially below the expected path, with the drop persisting long enough to suggest a structural change.',
    artifacts: ['Limited history'],
    tags: ['Low-volume caution'],
    whyItMatters:
      'This is a coherent month-long drop, but the limited comparable history means the queue should expose it with some caution.',
  },
  {
    id: 'graffiti-mn1',
    problem: 'Graffiti',
    detail: 'Storefront Marking',
    geographyId: 'manhattan-cb1',
    horizon: '7d',
    base: 12,
    intensity: 1.82,
    summary:
      'The latest week is elevated relative to a normally quiet baseline and is still compounding.',
    artifacts: ['Limited history'],
    tags: ['Newer taxonomy'],
    whyItMatters:
      'The signal is sharp and specific, but the limited comparable history warrants a lower priority than equally strong mature series.',
  },
  {
    id: 'noise-bk1',
    problem: 'Residential Noise',
    geographyId: 'brooklyn-cb1',
    horizon: '30d',
    base: 43,
    intensity: 1.34,
    summary:
      'The last month has shifted above the expected range and is not fading back into the normal weekly pulse.',
    artifacts: ['Possible taxonomy artifact'],
    tags: ['Sibling share shift'],
    whyItMatters:
      'The signal is meaningful, but the artifact flag lowers confidence because sibling noise details are reallocating share while the parent total is steadier.',
  },
  {
    id: 'street-citywide',
    problem: 'Street Condition',
    geographyId: 'citywide',
    horizon: 'today',
    base: 168,
    intensity: 1.55,
    summary:
      'Today is high across an unusually large share of the scored universe, which may reflect a real citywide intake shock.',
    artifacts: ['Panel-wide break'],
    tags: ['Universe-wide shock'],
    whyItMatters:
      'The raw severity is high, but the panel-wide break penalty keeps the alert visible without over-trusting a citywide one-day jump.',
  },
]

function addDays(date: Date, amount: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function hashSeed(input: string) {
  let hash = 2166136261

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function createRandom(seed: string) {
  let state = hashSeed(seed)

  return function next() {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function getDayOfYear(date: Date) {
  const start = new Date(date.getFullYear(), 0, 0)
  const diff =
    date.getTime() -
    start.getTime() +
    (start.getTimezoneOffset() - date.getTimezoneOffset()) * 60000

  return Math.floor(diff / 86400000)
}

function getStartOfQuarter(date: Date) {
  return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1)
}

function getGeography(id: string) {
  const geography = ALL_GEOGRAPHIES.find((item) => item.id === id)

  if (!geography) {
    throw new Error(`Unknown geography: ${id}`)
  }

  return geography
}

function getProblemDetails(problem: string) {
  const match = PROBLEM_CATALOG.find((entry) => entry.problem === problem)
  return match?.details ?? ['General']
}

function getWindowDays(horizon: Horizon) {
  if (horizon === 'today') {
    return 1
  }

  if (horizon === '7d') {
    return 7
  }

  if (horizon === '30d') {
    return 30
  }

  if (horizon === 'quarter') {
    return Math.max(
      1,
      Math.round(
        (TODAY.getTime() - getStartOfQuarter(TODAY).getTime()) / 86400000,
      ) + 1,
    )
  }

  return Math.max(1, Math.round((TODAY.getTime() - new Date(TODAY.getFullYear(), 0, 1).getTime()) / 86400000) + 1)
}

function createTimeline(blueprint: Blueprint) {
  const random = createRandom(`${blueprint.id}-timeline`)
  const direction = blueprint.direction === 'down' ? -1 : 1
  const totalDays = Math.round((TODAY.getTime() - START.getTime()) / 86400000) + 1
  const points: DailyPoint[] = []
  const quarterStartIso = toIsoDate(getStartOfQuarter(TODAY))
  const yearStartIso = `${TODAY.getFullYear()}-01-01`

  for (let dayIndex = 0; dayIndex < totalDays; dayIndex += 1) {
    const date = addDays(START, dayIndex)
    const isoDate = toIsoDate(date)
    const annualPhase = Math.sin((getDayOfYear(date) / 365) * Math.PI * 2 + random())
    const trend = 1 + dayIndex / totalDays / 7
    const expected =
      blueprint.base *
      trend *
      WEEKLY_PATTERN[date.getDay()] *
      (1 + annualPhase * 0.12)

    let effect = 1
    const localProgress = totalDays <= 1 ? 1 : dayIndex / (totalDays - 1)

    if (blueprint.horizon === 'today' && isoDate === toIsoDate(TODAY)) {
      effect = blueprint.intensity
    }

    if (blueprint.horizon === '7d') {
      const daysFromEnd = totalDays - dayIndex - 1
      if (daysFromEnd < 7) {
        effect = 1 + (blueprint.intensity - 1) * (0.45 + (6 - daysFromEnd) / 10)
      }
    }

    if (blueprint.horizon === '30d') {
      const daysFromEnd = totalDays - dayIndex - 1
      if (daysFromEnd < 30) {
        effect = 1 + (blueprint.intensity - 1) * (0.25 + (29 - daysFromEnd) / 40)
      }
    }

    if (blueprint.horizon === 'quarter' && isoDate >= quarterStartIso) {
      const progress =
        (date.getTime() - getStartOfQuarter(TODAY).getTime()) /
        Math.max(86400000, TODAY.getTime() - getStartOfQuarter(TODAY).getTime())
      effect = 1 + (blueprint.intensity - 1) * (0.2 + progress * 0.8)
    }

    if (blueprint.horizon === 'year' && isoDate >= yearStartIso) {
      const progress =
        (date.getTime() - new Date(TODAY.getFullYear(), 0, 1).getTime()) /
        Math.max(86400000, TODAY.getTime() - new Date(TODAY.getFullYear(), 0, 1).getTime())
      effect = 1 + (blueprint.intensity - 1) * (0.18 + progress * 0.82)
    }

    const noise = 0.92 + random() * 0.16 + Math.sin(localProgress * Math.PI * 6) * 0.02
    const directionEffect = direction === 1 ? effect : 1 / effect
    const actual = Math.max(0, Math.round(expected * directionEffect * noise))

    points.push({
      actual,
      date: isoDate,
      expected,
    })
  }

  return points
}

function aggregate(points: DailyPoint[], horizon: Horizon) {
  const days = getWindowDays(horizon)
  const window = points.slice(-days)

  if (horizon === 'today') {
    const current = window.at(-1)

    if (!current) {
      return { actual: 0, expected: 0 }
    }

    return {
      actual: current.actual,
      expected: current.expected,
    }
  }

  return window.reduce(
    (result, point) => ({
      actual: result.actual + point.actual,
      expected: result.expected + point.expected,
    }),
    { actual: 0, expected: 0 },
  )
}

function createHorizonScores(
  blueprint: Blueprint,
  deltaPct: number,
  actual: number,
  expected: number,
) {
  const directionBias = blueprint.direction === 'down' ? 0.9 : 1
  const magnitude = Math.abs(deltaPct)
  const baseScore = clamp(
    magnitude / 11 + Math.log1p(Math.abs(actual - expected)) * 0.46 * directionBias,
    2.1,
    8.9,
  )

  const scores: Record<Horizon, number> = {
    today: clamp(baseScore - 2.2, 1.5, 8.8),
    '7d': clamp(baseScore - 1.4, 1.8, 8.8),
    '30d': clamp(baseScore - 0.9, 2.0, 8.8),
    quarter: clamp(baseScore - 1.1, 2.0, 8.8),
    year: clamp(baseScore - 1.4, 2.0, 8.8),
  }

  const lift =
    blueprint.horizon === 'today'
      ? 2.6
      : blueprint.horizon === '7d'
        ? 2.4
        : blueprint.horizon === '30d'
          ? 2.1
          : blueprint.horizon === 'quarter'
            ? 2.5
            : 2.7

  scores[blueprint.horizon] = clamp(baseScore + lift, 4.4, 9.3)

  if (blueprint.secondarySignals?.some((label) => label.includes('Quarter'))) {
    scores.quarter = clamp(scores.quarter + 0.7, 2.2, 8.8)
  }

  if (blueprint.secondarySignals?.some((label) => label.includes('30-day'))) {
    scores['30d'] = clamp(scores['30d'] + 0.55, 2.2, 8.8)
  }

  if (blueprint.secondarySignals?.some((label) => label.includes('Today'))) {
    scores.today = clamp(scores.today + 0.45, 2.0, 8.8)
  }

  return scores
}

function createSignalBreakdown(
  blueprint: Blueprint,
  actual: number,
  deltaPct: number,
  dominantScore: number,
) {
  const geography = getGeography(blueprint.geographyId)
  const artifactPenalty = (blueprint.artifacts ?? []).reduce(
    (sum, artifact) => sum + ARTIFACT_PENALTIES[artifact],
    0,
  )

  const severity = clamp(dominantScore * 12.2, 42, 98)
  const impact = clamp(Math.log1p(actual) * 17 + Math.abs(deltaPct) * 0.45, 22, 97)
  const persistence =
    blueprint.horizon === 'today'
      ? 36
      : blueprint.horizon === '7d'
        ? 62
        : blueprint.horizon === '30d'
          ? 74
          : blueprint.horizon === 'quarter'
            ? 83
            : 89
  const breadth =
    geography.type === 'citywide'
      ? 91
      : geography.type === 'borough'
        ? 72
        : 54
  const specificity = blueprint.detail || blueprint.surfaceLevel === 'detail' ? 82 : 56

  return {
    artifactPenalty,
    breadth,
    impact,
    persistence,
    severity,
    specificity,
  } satisfies SignalBreakdown
}

function createPriority(signal: SignalBreakdown) {
  return Math.round(
    clamp(
      signal.severity * 0.45 +
        signal.impact * 0.25 +
        signal.persistence * 0.15 +
        signal.breadth * 0.1 +
        signal.specificity * 0.05 -
        signal.artifactPenalty,
      8,
      99,
    ),
  )
}

function createSparkline(points: DailyPoint[]) {
  return points.slice(-28).map((point) => point.actual)
}

function createContributors(blueprint: Blueprint, actual: number, expected: number) {
  const details = getProblemDetails(blueprint.problem)
  const random = createRandom(`${blueprint.id}-contributors`)
  const shares =
    blueprint.detail && details.includes(blueprint.detail)
      ? details.map((detail, index) =>
          detail === blueprint.detail ? 0.64 : index === 0 ? 0.21 : 0.15,
        )
      : details.map((_detail, index) => (index === 0 ? 0.4 : index === 1 ? 0.33 : 0.27))

  return details.slice(0, 3).map((detail, index) => ({
    actual: Math.round(actual * shares[index]),
    expected: Math.round(expected * (shares[index] - (random() - 0.5) * 0.08)),
    name: detail,
    share: Math.round(shares[index] * 100),
  })) satisfies Contributor[]
}

function createMap(blueprint: Blueprint) {
  const geography = getGeography(blueprint.geographyId)
  const random = createRandom(`${blueprint.id}-map`)
  const direction = blueprint.direction === 'down' ? -1 : 1
  const rows = DISTRICT_DEFINITIONS.map((district, index) => {
    let multiplier = 0.98 + random() * 0.12

    if (geography.type === 'citywide') {
      multiplier += 0.18 + random() * 0.18
    } else if (geography.type === 'borough' && district.borough === geography.borough) {
      multiplier += 0.26 + random() * 0.34
    } else if (geography.type === 'community-board') {
      if (district.id === geography.id) {
        multiplier += 0.44 + random() * 0.44
      } else if (district.borough === geography.borough) {
        multiplier += 0.14 + random() * 0.2
      }
    }

    if (direction === -1) {
      multiplier = 1 / multiplier
    }

    const expected = Math.round(6 + blueprint.base * 0.22 + random() * 9 + (index % 4))
    const actual = Math.max(0, Math.round(expected * multiplier))

    return {
      actual,
      borough: district.borough,
      code: district.code,
      expected,
      id: district.id,
      intensity: actual / Math.max(1, expected),
      isFocus:
        geography.type === 'borough'
          ? district.borough === geography.borough
          : geography.type === 'community-board'
            ? district.id === geography.id
            : false,
      label: district.shortLabel,
    } satisfies DistrictDatum
  })

  if (geography.type !== 'citywide') {
    return rows
  }

  const focusIds = new Set(
    [...rows]
      .sort(
        (left, right) =>
          Math.abs(right.actual - right.expected) - Math.abs(left.actual - left.expected),
      )
      .slice(0, 8)
      .map((row) => row.id),
  )

  return rows.map((row) => ({
    ...row,
    isFocus: focusIds.has(row.id),
  }))
}

function createProjectedPercentile(blueprint: Blueprint, deltaPct: number) {
  if (blueprint.horizon !== 'quarter' && blueprint.horizon !== 'year') {
    return undefined
  }

  if (blueprint.direction === 'down') {
    return clamp(10 - Math.round(Math.abs(deltaPct) / 8), 1, 10)
  }

  return clamp(93 + Math.round(Math.abs(deltaPct) / 10), 93, 99)
}

function createQueueReason(blueprint: Blueprint, dominantScore: number) {
  if (blueprint.queueReason) {
    return blueprint.queueReason
  }

  if (blueprint.secondarySignals?.length) {
    return `Severity ${dominantScore.toFixed(1)} with ${blueprint.secondarySignals[0].toLowerCase()}`
  }

  return `Severity ${dominantScore.toFixed(1)} on the dominant ${blueprint.horizon} horizon`
}

function createAlertRecord(blueprint: Blueprint): AlertRecord {
  const geography = getGeography(blueprint.geographyId)
  const timeline = createTimeline(blueprint)
  const aggregateWindow = aggregate(timeline, blueprint.horizon)
  const deltaPct =
    ((aggregateWindow.actual - aggregateWindow.expected) / Math.max(1, aggregateWindow.expected)) *
    100
  const horizonScores = createHorizonScores(
    blueprint,
    deltaPct,
    aggregateWindow.actual,
    aggregateWindow.expected,
  )
  const signal = createSignalBreakdown(
    blueprint,
    aggregateWindow.actual,
    deltaPct,
    horizonScores[blueprint.horizon],
  )
  const priority = createPriority(signal)
  const title = blueprint.detail ?? blueprint.problem

  return {
    actual: Math.round(aggregateWindow.actual),
    artifacts: blueprint.artifacts ?? [],
    comparabilityStart:
      blueprint.artifacts?.includes('Limited history') === true ? '2025-04-14' : '2022-01-01',
    contributors: createContributors(
      blueprint,
      Math.round(aggregateWindow.actual),
      Math.round(aggregateWindow.expected),
    ),
    deltaPct,
    detail: blueprint.detail,
    direction: blueprint.direction ?? 'up',
    expected: Math.round(aggregateWindow.expected),
    geography,
    horizon: blueprint.horizon,
    horizonScores,
    id: blueprint.id,
    map: createMap(blueprint),
    priority,
    problem: blueprint.problem,
    projectedPercentile: createProjectedPercentile(blueprint, deltaPct),
    queueReason: createQueueReason(blueprint, horizonScores[blueprint.horizon]),
    secondarySignals: blueprint.secondarySignals ?? [],
    signal,
    sparkline: createSparkline(timeline),
    summary: blueprint.summary,
    surfaceLevel: blueprint.surfaceLevel ?? (blueprint.detail ? 'detail' : 'problem'),
    tags: blueprint.tags ?? [],
    timeline,
    title,
    whyItMatters:
      blueprint.whyItMatters ??
      'The queue score combines dominant-horizon severity with impact, persistence, and whether the anomaly stays specific enough to explain cleanly.',
  }
}

function createSyntheticGeographyScores(seed: string) {
  const random = createRandom(`${seed}-geo-breakdown`)
  const geographyPool = [
    ...COMMUNITY_BOARDS.slice(0, 8),
    BOROUGHS[1],
    BOROUGHS[3],
  ]

  return geographyPool.map((geography, index) => {
    const expected = Math.round(12 + random() * 60)
    const actual = Math.round(expected * (0.84 + random() * 0.42))
    const deltaPct = ((actual - expected) / Math.max(1, expected)) * 100

    return {
      actual,
      deltaPct,
      expected,
      geography,
      priority: Math.round(clamp(48 + random() * 28 - index * 2, 22, 79)),
      status: index < 2 ? 'watch' : 'quiet',
    } satisfies GeographyScore
  })
}

function createQuietEntity(problem: string, detail?: string): EntityRecord {
  const seed = `${problem}-${detail ?? 'problem'}`
  const random = createRandom(`${seed}-quiet`)
  const quietBlueprint: Blueprint = {
    base: 12 + random() * 28,
    detail,
    geographyId: 'citywide',
    horizon: '30d',
    id: `${seed}-quiet`,
    intensity: 1.08,
    problem,
    summary: '',
  }

  const timeline = createTimeline(quietBlueprint)
  const horizonScores = {
    today: Number((1.8 + random() * 0.9).toFixed(1)),
    '7d': Number((2.1 + random() * 1.0).toFixed(1)),
    '30d': Number((2.4 + random() * 1.1).toFixed(1)),
    quarter: Number((2.2 + random() * 1.1).toFixed(1)),
    year: Number((2.0 + random() * 1.0).toFixed(1)),
  }

  const defaultHorizon = HORIZONS.reduce((best, current) =>
    horizonScores[current] > horizonScores[best] ? current : best,
  )
  const map = createMap({
    base: 14,
    detail,
    geographyId: 'citywide',
    horizon: '30d',
    id: `${seed}-map`,
    intensity: 1.08,
    problem,
    summary: '',
  })

  return {
    activeAlertCount: 0,
    artifacts: [],
    contributors: createContributors(
      {
        base: 20,
        detail,
        geographyId: 'citywide',
        horizon: '30d',
        id: `${seed}-contributors`,
        intensity: 1.08,
        problem,
        summary: '',
      },
      62,
      58,
    ),
    currentStatus: defaultHorizon === '30d' || defaultHorizon === 'quarter' ? 'watch' : 'quiet',
    defaultHorizon,
    geographyBreakdown: createSyntheticGeographyScores(seed),
    horizonScores,
    id: detail ? `detail:${problem}:${detail}` : `problem:${problem}`,
    map,
    name: detail ?? problem,
    parentProblem: detail ? problem : undefined,
    sparkline: createSparkline(timeline),
    summary: `Currently quiet. The highest residual watch is on the ${defaultHorizon} horizon, but it stays below queue threshold.`,
    timeline,
    type: detail ? 'detail' : 'problem',
  }
}

function buildEntity(alerts: AlertRecord[], problem: string, detail?: string) {
  const relatedAlerts = alerts.filter((alert) => {
    if (detail) {
      return alert.problem === problem && alert.detail === detail
    }

    return alert.problem === problem
  })

  if (relatedAlerts.length === 0) {
    return createQuietEntity(problem, detail)
  }

  const topAlert = [...relatedAlerts].sort((left, right) => right.priority - left.priority)[0]
  const artifacts = [...new Set(relatedAlerts.flatMap((alert) => alert.artifacts))]
  const horizonScores = HORIZONS.reduce(
    (result, horizon) => ({
      ...result,
      [horizon]: Number(
        Math.max(...relatedAlerts.map((alert) => alert.horizonScores[horizon])).toFixed(1),
      ),
    }),
    {} as Record<Horizon, number>,
  )
  const currentStatus: StatusTone =
    topAlert.priority >= 78 ? 'active' : topAlert.priority >= 58 ? 'watch' : 'quiet'
  const geographyMap = new Map<string, GeographyScore>()

  for (const alert of [...relatedAlerts].sort((left, right) => right.priority - left.priority)) {
    if (!geographyMap.has(alert.geography.id)) {
      geographyMap.set(alert.geography.id, {
        actual: alert.actual,
        deltaPct: alert.deltaPct,
        expected: alert.expected,
        geography: alert.geography,
        priority: alert.priority,
        status:
          alert.priority >= 78
            ? 'active'
            : alert.priority >= 58
              ? 'watch'
              : 'quiet',
      })
    }
  }

  const geographyBreakdown = Array.from(geographyMap.values())

  const syntheticBreakdown = createSyntheticGeographyScores(
    `${problem}-${detail ?? 'problem'}`,
  )

  for (const synthetic of syntheticBreakdown) {
    if (geographyBreakdown.length >= 6) {
      break
    }

    if (!geographyMap.has(synthetic.geography.id)) {
      geographyBreakdown.push(synthetic)
      geographyMap.set(synthetic.geography.id, synthetic)
    }
  }

  return {
    activeAlertCount: relatedAlerts.length,
    artifacts,
    contributors: topAlert.contributors,
    currentStatus,
    defaultHorizon: topAlert.horizon,
    geographyBreakdown,
    horizonScores,
    id: detail ? `detail:${problem}:${detail}` : `problem:${problem}`,
    map: topAlert.map,
    name: detail ?? problem,
    parentProblem: detail ? problem : undefined,
    sparkline: topAlert.sparkline,
    summary:
      currentStatus === 'active'
        ? `${topAlert.geography.shortLabel} is the clearest live view for this category, with the signal reading strongest on ${topAlert.horizon}.`
        : `This category is on watch but not in the queue.`,
    timeline: topAlert.timeline,
    topAlertId: topAlert.id,
    type: detail ? 'detail' : 'problem',
  } satisfies EntityRecord
}

const ALERTS = BLUEPRINTS.map(createAlertRecord).sort((left, right) => right.priority - left.priority)

const ENTITY_INDEX = PROBLEM_CATALOG.flatMap((entry) => [
  buildEntity(ALERTS, entry.problem),
  ...entry.details.map((detail) => buildEntity(ALERTS, entry.problem, detail)),
]).sort((left, right) => {
  if (left.currentStatus !== right.currentStatus) {
    return left.currentStatus === 'active' ? -1 : right.currentStatus === 'active' ? 1 : 0
  }

  return left.name.localeCompare(right.name)
})

export const dashboardData: DashboardData = {
  allAlerts: ALERTS,
  entities: ENTITY_INDEX,
  fixedHorizon: {
    '7d': ALERTS.filter((alert) => alert.horizon === '7d'),
    '30d': ALERTS.filter((alert) => alert.horizon === '30d'),
    quarter: ALERTS.filter((alert) => alert.horizon === 'quarter'),
    year: ALERTS.filter((alert) => alert.horizon === 'year'),
  },
  generatedAt: TODAY.toISOString(),
  lastRefresh: '2026-03-30',
  mainQueue: ALERTS.slice(0, 25),
  metrics: {
    activeAlerts: ALERTS.length,
    boardAlerts: ALERTS.filter((alert) => alert.geography.type === 'community-board').length,
    citywideAlerts: ALERTS.filter((alert) => alert.geography.type === 'citywide').length,
    flaggedAlerts: ALERTS.filter((alert) => alert.artifacts.length > 0).length,
  },
}
