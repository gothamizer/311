import { useEffect, useMemo, useState } from 'react'
import { geoMercator, geoPath } from 'd3-geo'

import communityDistricts from '../data/community-districts.json'
import { formatCount, formatDelta } from '../lib/format'
import type { DistrictDatum, GeographyType } from '../types'

interface DistrictMapProps {
  // The descriptor currently being filtered to, if any. Geographic concentration
  // is shown for all descriptors, so we surface a small note rather than redraw.
  activeDetailName?: string
  direction: 'up' | 'down'
  districts: DistrictDatum[]
  geographyType: GeographyType
  // The board / borough that the alert itself is about, used to drive focus.
  selectedBorough?: string
  selectedGeographyId?: string
}

const MAP_WIDTH = 520
const MAP_HEIGHT = 470

// Boards carry a borough id on the datum; the GeoJSON only has the numeric code
// whose leading digit maps to a borough. Keep them aligned for context dimming.
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

// Map a board's deviation onto a 0..1 ramp position. Intensity is actual/expected,
// so 1 = on baseline. We work in log space and normalize against the strongest
// board on the map so a city with a single 20x hotspot doesn't paint everything
// solid (the previous linear scale saturated above ~1.8x).
function rampPosition(intensity: number, direction: 'up' | 'down', maxLogDeviation: number) {
  const deviation = direction === 'up' ? Math.max(0, intensity - 1) : Math.max(0, 1 - intensity)

  if (deviation <= 0 || maxLogDeviation <= 0) {
    return 0
  }

  return Math.min(1, Math.log1p(deviation) / maxLogDeviation)
}

function tone(direction: 'up' | 'down', position: number, dimmed: boolean) {
  if (position <= 0) {
    // On / below baseline: a faint neutral fill so the board still reads as "known".
    return dimmed ? 'rgba(148, 163, 184, 0.05)' : 'rgba(148, 163, 184, 0.1)'
  }

  const alpha = (0.14 + position * 0.78) * (dimmed ? 0.32 : 1)

  return direction === 'up'
    ? `rgba(255, 176, 76, ${alpha})`
    : `rgba(116, 209, 214, ${alpha})`
}

function deviationPct(district: DistrictDatum) {
  return ((district.actual - district.expected) / Math.max(1, district.expected)) * 100
}

export function DistrictMap({
  activeDetailName,
  direction,
  districts,
  geographyType,
  selectedBorough,
  selectedGeographyId,
}: DistrictMapProps) {
  const districtByCode = useMemo(
    () => new Map(districts.map((district) => [district.code, district])),
    [districts],
  )

  // A board is "in focus region" when it belongs to the part of the city this
  // alert is about: the whole city for citywide alerts, the borough for borough /
  // community-board alerts. Out-of-region boards are dimmed for context only.
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

  // Calibrate the ramp against the boards that are actually in the focus region and
  // carry data, so the contrast lives where the story is.
  const maxLogDeviation = useMemo(() => {
    const deviations = districts
      .filter((district) => district.hasData && isInRegion(district))
      .map((district) =>
        direction === 'up'
          ? Math.max(0, district.intensity - 1)
          : Math.max(0, 1 - district.intensity),
      )
      .filter((value) => value > 0)
      .sort((left, right) => left - right)

    if (!deviations.length) {
      return 0
    }

    // Cap at the ~90th percentile so a lone extreme board doesn't flatten the rest.
    const capped = deviations[Math.floor((deviations.length - 1) * 0.9)]
    return Math.log1p(capped)
  }, [direction, districts, isInRegion])

  const projectedDistricts = useMemo(() => {
    const projection = geoMercator().fitSize([MAP_WIDTH, MAP_HEIGHT], districtShapes as never)
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

  // Default focus: the alert's own geography, else the strongest board in region.
  const defaultDistrictId = useMemo(() => {
    if (selectedGeographyId && districts.some((district) => district.id === selectedGeographyId)) {
      return selectedGeographyId
    }

    const ranked = districts
      .filter((district) => district.hasData && isInRegion(district))
      .sort(
        (left, right) =>
          rampPosition(right.intensity, direction, maxLogDeviation) -
          rampPosition(left.intensity, direction, maxLogDeviation),
      )

    return ranked[0]?.id ?? districts.find((district) => district.isFocus)?.id ?? districts[0]?.id
  }, [direction, districts, isInRegion, maxLogDeviation, selectedGeographyId])

  const [activeDistrictId, setActiveDistrictId] = useState<string | undefined>(defaultDistrictId)

  useEffect(() => {
    setActiveDistrictId(defaultDistrictId)
  }, [defaultDistrictId])

  const activeDistrict =
    districts.find((district) => district.id === activeDistrictId) ?? districts[0]

  if (!activeDistrict) {
    return null
  }

  const headline =
    geographyType === 'citywide'
      ? 'Where it concentrates citywide'
      : geographyType === 'borough'
        ? `Concentration across ${focusBorough ?? 'the borough'}`
        : `${activeDistrict.label} in local context`

  return (
    <div className="district-map">
      <div className="district-map__header">
        <div>
          <p className="section-kicker">Community districts</p>
          <h3 className="section-title">{headline}</h3>
        </div>
        <div className="district-map__legend">
          <span>On baseline</span>
          <span className={`district-map__legend-ramp district-map__legend-ramp--${direction}`} />
          <span>{direction === 'up' ? 'Far above' : 'Far below'}</span>
        </div>
      </div>

      <svg className="district-map__surface" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}>
        {projectedDistricts.map(({ borough, district, path }) => {
          if (!district) {
            // A board with no series at all for this problem: faint outline only.
            const dimmed = Boolean(focusBorough) && borough !== focusBorough
            return (
              <path
                key={`empty-${path.slice(0, 12)}`}
                d={path}
                fill="rgba(148, 163, 184, 0.04)"
                stroke={`rgba(148, 163, 184, ${dimmed ? 0.07 : 0.12})`}
                strokeWidth={0.7}
                vectorEffect="non-scaling-stroke"
              />
            )
          }

          const inRegion = isInRegion(district)
          const isActive = district.id === activeDistrict.id
          const isFocus = district.isFocus
          const position = district.hasData
            ? rampPosition(district.intensity, direction, maxLogDeviation)
            : 0

          return (
            <path
              key={district.id}
              d={path}
              fill={district.hasData ? tone(direction, position, !inRegion) : 'rgba(148, 163, 184, 0.05)'}
              stroke={
                isActive
                  ? 'rgba(248, 250, 252, 0.95)'
                  : isFocus
                    ? 'rgba(248, 250, 252, 0.7)'
                    : inRegion
                      ? 'rgba(248, 250, 252, 0.16)'
                      : 'rgba(248, 250, 252, 0.07)'
              }
              strokeWidth={isActive ? 2.2 : isFocus ? 1.6 : 0.8}
              vectorEffect="non-scaling-stroke"
              onMouseEnter={() => setActiveDistrictId(district.id)}
            />
          )
        })}
      </svg>

      <div className="district-map__footer">
        <div>
          <p className="metric-label">{activeDistrict.isFocus ? 'This alert' : 'Hovered district'}</p>
          <p className="metric-figure">{activeDistrict.label}</p>
        </div>
        <div>
          <p className="metric-label">Actual vs expected</p>
          <p className="metric-figure">
            {activeDistrict.hasData
              ? `${formatCount(activeDistrict.actual)} / ${formatCount(activeDistrict.expected)}`
              : 'No volume'}
          </p>
        </div>
        <div>
          <p className="metric-label">Deviation</p>
          <p className="metric-figure">
            {activeDistrict.hasData ? formatDelta(deviationPct(activeDistrict)) : '—'}
          </p>
        </div>
      </div>

      {activeDetailName ? (
        <p className="district-map__note">
          Geographic split reflects all descriptors. {activeDetailName} totals are in the metric strip and trend.
        </p>
      ) : null}
    </div>
  )
}
