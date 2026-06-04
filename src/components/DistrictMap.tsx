import { useMemo, useState } from 'react'
import { geoMercator, geoPath } from 'd3-geo'

import communityDistricts from '../data/community-districts.json'
import { formatCount, formatDelta } from '../lib/format'
import type { DistrictDatum, GeographyType } from '../types'

type MapMode = 'volume' | 'concentration' | 'deviation'

interface DistrictMapProps {
  // The descriptor currently being filtered to, if any.
  activeDetailName?: string
  direction: 'up' | 'down'
  districts: DistrictDatum[]
  geographyType: GeographyType
  // The problem this map decomposes, used in the mode descriptions.
  subjectLabel?: string
  // The board / borough that the alert itself is about, used to drive focus.
  selectedBorough?: string
  selectedGeographyId?: string
}

// NYC's projected bounding box is essentially square, so a square viewbox fills
// without letterboxing.
const MAP_SIZE = 600

// Boards carry a borough id on the datum; the GeoJSON only has the numeric code
// whose leading digit maps to a borough. Keep them aligned for focus outlining.
const BOROUGH_BY_CODE_PREFIX: Record<string, string> = {
  '1': 'Manhattan',
  '2': 'Bronx',
  '3': 'Brooklyn',
  '4': 'Queens',
  '5': 'Staten Island',
}

const districtShapes = communityDistricts as {
  features: Array<{
    geometry: unknown
    properties: { code: string }
    type: string
  }>
  type: string
}

const MODE_LABEL: Record<MapMode, string> = {
  volume: 'Volume',
  concentration: 'Concentration',
  deviation: 'Deviation',
}

// Plain-language one-liner shown under the toggle so each mode reads clearly to a
// non-technical reader.
function modeDescription(mode: MapMode, subject: string) {
  switch (mode) {
    case 'volume':
      return `How many ${subject} calls land in each district.`
    case 'concentration':
      return `Where ${subject} is over-represented versus a district's usual 311 load.`
    default:
      return 'How far each district sits above or below its own seasonal baseline.'
  }
}

function deviationMagnitude(intensity: number, direction: 'up' | 'down') {
  return direction === 'up' ? Math.max(0, intensity - 1) : Math.max(0, 1 - intensity)
}

function deviationPct(district: DistrictDatum) {
  return ((district.actual - district.expected) / Math.max(1, district.expected)) * 100
}

// A board's share of this problem ÷ its share of all 311 activity. >1 means the
// problem is over-represented here relative to how busy the district usually is.
function locationQuotient(district: DistrictDatum, sumActual: number) {
  const share = sumActual > 0 ? district.actual / sumActual : 0
  const activity = district.activityShare ?? 0

  if (activity <= 0 || share <= 0) {
    return undefined
  }

  return share / activity
}

function formatLq(value: number) {
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}×`
}

// 90th-percentile cap of a set of positive values in log space, so a lone extreme
// board doesn't flatten the ramp for everyone else.
function cappedLogScale(values: number[]) {
  const positive = values.filter((value) => value > 0).sort((left, right) => left - right)

  if (!positive.length) {
    return 0
  }

  return Math.log1p(positive[Math.floor((positive.length - 1) * 0.9)])
}

export function DistrictMap({
  activeDetailName,
  direction,
  districts,
  geographyType,
  subjectLabel,
  selectedBorough,
  selectedGeographyId,
}: DistrictMapProps) {
  const accent = direction === 'up' ? 'var(--alert)' : 'var(--cool)'
  const subject = subjectLabel ?? 'these'

  const hasConcentration = useMemo(
    () => districts.some((district) => (district.activityShare ?? 0) > 0),
    [districts],
  )
  const availableModes = useMemo<MapMode[]>(
    () => (hasConcentration ? ['volume', 'concentration', 'deviation'] : ['volume', 'deviation']),
    [hasConcentration],
  )

  const [mode, setMode] = useState<MapMode>('volume')
  const activeMode = availableModes.includes(mode) ? mode : 'volume'

  // A board is "in the focus region" when it belongs to the part of the city this
  // alert is about: the whole city for citywide alerts, the borough for borough /
  // community-board alerts. Focus is drawn as an outline, never a fill change.
  const focusBorough =
    geographyType === 'citywide'
      ? undefined
      : selectedBorough ??
        districts.find((district) => district.id === selectedGeographyId)?.borough

  const isInRegion = useMemo(() => {
    return (district: DistrictDatum) => {
      if (geographyType === 'citywide' || !focusBorough) {
        return true
      }

      return district.borough === focusBorough
    }
  }, [focusBorough, geographyType])

  // Location quotient per board (concentration mode), measured against the citywide
  // call total for this problem.
  const lqById = useMemo(() => {
    const total = districts.reduce(
      (sum, district) => (district.hasData ? sum + district.actual : sum),
      0,
    )
    const byId = new Map<string, number>()

    for (const district of districts) {
      if (!district.hasData) {
        continue
      }

      const lq = locationQuotient(district, total)

      if (lq !== undefined) {
        byId.set(district.id, lq)
      }
    }

    return byId
  }, [districts])

  // Per-mode ramp calibration, computed across every board with data so colour is
  // comparable across the whole city.
  const calibration = useMemo(() => {
    const withData = districts.filter((district) => district.hasData)

    return {
      volume: cappedLogScale(withData.map((district) => district.actual)),
      concentration: cappedLogScale(
        withData.map((district) => Math.max(0, (lqById.get(district.id) ?? 0) - 1)),
      ),
      deviation: cappedLogScale(
        withData.map((district) => deviationMagnitude(district.intensity, direction)),
      ),
    }
  }, [direction, districts, lqById])

  // Map a board onto a 0..1 ramp position for the active mode.
  const positionFor = useMemo(() => {
    return (district: DistrictDatum) => {
      if (!district.hasData) {
        return 0
      }

      if (activeMode === 'volume') {
        return calibration.volume > 0 ? Math.min(1, Math.log1p(district.actual) / calibration.volume) : 0
      }

      if (activeMode === 'concentration') {
        const lq = lqById.get(district.id)

        if (!lq || lq <= 1 || calibration.concentration <= 0) {
          return 0
        }

        return Math.min(1, Math.log1p(lq - 1) / calibration.concentration)
      }

      const magnitude = deviationMagnitude(district.intensity, direction)
      return magnitude > 0 && calibration.deviation > 0
        ? Math.min(1, Math.log1p(magnitude) / calibration.deviation)
        : 0
    }
  }, [activeMode, calibration, direction, lqById])

  // The value a district is ranked by, in the active mode.
  const metricValue = useMemo(() => {
    return (district: DistrictDatum) => {
      if (activeMode === 'volume') {
        return district.actual
      }

      if (activeMode === 'concentration') {
        return lqById.get(district.id) ?? 0
      }

      return deviationMagnitude(district.intensity, direction)
    }
  }, [activeMode, direction, lqById])

  const rankedRegion = useMemo(
    () =>
      districts
        .filter((district) => district.hasData && isInRegion(district))
        .sort((left, right) => metricValue(right) - metricValue(left)),
    [districts, isInRegion, metricValue],
  )

  const districtByCode = useMemo(
    () => new Map(districts.map((district) => [district.code, district])),
    [districts],
  )

  const projectedDistricts = useMemo(() => {
    const projection = geoMercator().fitSize([MAP_SIZE, MAP_SIZE], districtShapes as never)
    const pathGenerator = geoPath(projection)

    return districtShapes.features
      .map((feature) => {
        const district = districtByCode.get(feature.properties.code)
        const borough = BOROUGH_BY_CODE_PREFIX[feature.properties.code[0]]

        return {
          borough,
          district,
          path: pathGenerator(feature as never) ?? '',
        }
      })
      .filter((entry) => Boolean(entry.path))
  }, [districtByCode])

  // The alert's own anchor: its board (community-board alert) or, for borough /
  // citywide alerts, the most deviating board in region — a stable default that does
  // not jump around when the colour mode changes.
  const anchorDistrictId = useMemo(() => {
    if (selectedGeographyId && districts.some((district) => district.id === selectedGeographyId)) {
      return selectedGeographyId
    }

    const byDeviation = districts
      .filter((district) => district.hasData && isInRegion(district))
      .sort(
        (left, right) =>
          deviationMagnitude(right.intensity, direction) - deviationMagnitude(left.intensity, direction),
      )

    return byDeviation[0]?.id ?? districts.find((district) => district.isFocus)?.id ?? districts[0]?.id
  }, [direction, districts, isInRegion, selectedGeographyId])

  // The readout follows an explicit click, never hover. The pin is tagged with the
  // anchor it belongs to, so switching alerts drops a stale pin without an effect.
  const [pinned, setPinned] = useState<{ anchorId?: string; id: string }>()

  const pinnedId = pinned?.anchorId === anchorDistrictId ? pinned.id : undefined
  const activeId = pinnedId ?? anchorDistrictId
  const activeDistrict = districts.find((district) => district.id === activeId) ?? districts[0]

  if (!activeDistrict) {
    return null
  }

  const isAnchorActive = activeDistrict.id === anchorDistrictId
  const activeRank = rankedRegion.findIndex((district) => district.id === activeDistrict.id)
  const regionLabel = geographyType === 'citywide' || !focusBorough ? 'citywide' : `in ${focusBorough}`
  const activeLq = lqById.get(activeDistrict.id)

  function selectDistrict(id: string) {
    setPinned((current) =>
      current?.anchorId === anchorDistrictId && current.id === id
        ? undefined
        : { anchorId: anchorDistrictId, id },
    )
  }

  return (
    <section
      className={`district-map district-map--${direction} district-map--${activeMode}`}
      aria-label="Geographic concentration"
    >
      <header className="district-map__head">
        <div className="district-map__modes" role="tablist" aria-label="Map metric">
          {availableModes.map((option) => (
            <button
              key={option}
              role="tab"
              aria-selected={option === activeMode}
              className={`district-map__mode ${option === activeMode ? 'is-active' : ''}`}
              type="button"
              onClick={() => setMode(option)}
            >
              {MODE_LABEL[option]}
            </button>
          ))}
        </div>
        <p className="district-map__mode-note">{modeDescription(activeMode, subject)}</p>
      </header>

      <div className="district-map__body">
        <div className="district-map__plot">
          <svg
            className="district-map__surface"
            viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`}
            role="group"
            aria-label="Community district map"
          >
            {projectedDistricts.map(({ borough, district, path }) => {
              const inRegion = district ? isInRegion(district) : borough === focusBorough
              const hasData = Boolean(district?.hasData)
              const position = district ? positionFor(district) : 0
              const isActive = Boolean(district && district.id === activeDistrict.id)
              const isAnchor = Boolean(district && district.id === anchorDistrictId)

              const stroke = isActive
                ? 'rgba(248, 250, 252, 0.96)'
                : isAnchor
                  ? accent
                  : inRegion
                    ? 'rgba(248, 250, 252, 0.22)'
                    : 'rgba(148, 163, 184, 0.12)'
              const strokeWidth = isActive ? 2.4 : isAnchor ? 1.8 : inRegion ? 0.9 : 0.6

              return (
                <path
                  key={district?.id ?? `empty-${path.slice(0, 14)}`}
                  className={`district-map__cell ${district ? 'is-interactive' : ''} ${
                    isActive ? 'is-active' : ''
                  }`}
                  d={path}
                  fill={hasData ? cellFill(activeMode, direction, position) : 'rgba(148, 163, 184, 0.05)'}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  vectorEffect="non-scaling-stroke"
                  onClick={district ? () => selectDistrict(district.id) : undefined}
                >
                  {district ? <title>{district.label}</title> : null}
                </path>
              )
            })}
          </svg>
        </div>

        <aside className="district-map__rail">
          <header className="district-map__readout">
            <p className="district-map__rail-kicker">
              {isAnchorActive
                ? geographyType === 'community-board'
                  ? 'This district'
                  : 'Strongest district'
                : 'Pinned district'}
            </p>
            <h3 className="district-map__rail-title">{activeDistrict.label}</h3>

            <dl className="district-map__stats">
              <div className={activeMode === 'volume' ? 'is-active-metric' : ''}>
                <dt>Calls</dt>
                <dd>{activeDistrict.hasData ? formatCount(activeDistrict.actual) : 'No volume'}</dd>
              </div>
              {hasConcentration ? (
                <div className={activeMode === 'concentration' ? 'is-active-metric' : ''}>
                  <dt>Concentration</dt>
                  <dd>{activeLq ? `${formatLq(activeLq)} usual share` : '—'}</dd>
                </div>
              ) : null}
              <div className={activeMode === 'deviation' ? 'is-active-metric' : ''}>
                <dt>vs. expected</dt>
                <dd>{activeDistrict.hasData ? formatDelta(deviationPct(activeDistrict)) : '—'}</dd>
              </div>
              {activeRank >= 0 && rankedRegion.length > 1 ? (
                <div>
                  <dt>Rank</dt>
                  <dd>
                    #{activeRank + 1} of {rankedRegion.length} {regionLabel}
                  </dd>
                </div>
              ) : null}
            </dl>
          </header>

          <footer className="district-map__rail-footer">
            <div className="district-map__legend">
              <span>{LEGEND_ENDS[activeMode === 'deviation' ? direction : activeMode][0]}</span>
              <span className={`district-map__legend-ramp district-map__legend-ramp--${activeMode === 'deviation' ? direction : activeMode}`} />
              <span>{LEGEND_ENDS[activeMode === 'deviation' ? direction : activeMode][1]}</span>
            </div>
            <p className="district-map__hint">
              {activeDetailName
                ? `Filtered to ${activeDetailName}. `
                : ''}
              Click a district to inspect it.
            </p>
          </footer>
        </aside>
      </div>
    </section>
  )
}

// Fill colour by mode. Volume reads as neutral magnitude (ice blue), concentration
// as a distinct "stands out" hue (violet), deviation keeps the alert palette.
function cellFill(mode: MapMode, direction: 'up' | 'down', position: number) {
  if (position <= 0) {
    return 'rgba(148, 163, 184, 0.09)'
  }

  const alpha = 0.12 + position * 0.82

  if (mode === 'volume') {
    return `rgba(99, 179, 237, ${alpha})`
  }

  if (mode === 'concentration') {
    return `rgba(167, 139, 250, ${alpha})`
  }

  return direction === 'up' ? `rgba(255, 176, 76, ${alpha})` : `rgba(116, 209, 214, ${alpha})`
}

const LEGEND_ENDS: Record<string, [string, string]> = {
  volume: ['Fewer', 'More'],
  concentration: ['Typical', 'Concentrated'],
  up: ['On baseline', 'Far above'],
  down: ['On baseline', 'Far below'],
}
