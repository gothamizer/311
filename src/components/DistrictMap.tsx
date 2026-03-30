import { useEffect, useMemo, useState } from 'react'
import { geoMercator, geoPath } from 'd3-geo'

import communityDistricts from '../data/community-districts.json'
import { formatCount, formatDelta } from '../lib/format'
import type { DistrictDatum } from '../types'

interface DistrictMapProps {
  direction: 'up' | 'down'
  districts: DistrictDatum[]
  selectedGeographyId?: string
}

const MAP_WIDTH = 520
const MAP_HEIGHT = 470

function getDistrictTone(direction: 'up' | 'down', intensity: number) {
  const normalized =
    direction === 'up'
      ? Math.max(0, Math.min(1, (intensity - 0.88) / 0.9))
      : Math.max(0, Math.min(1, (1.12 - intensity) / 0.72))

  if (direction === 'up') {
    return `rgba(255, 176, 76, ${0.08 + normalized * 0.82})`
  }

  return `rgba(116, 209, 214, ${0.08 + normalized * 0.8})`
}

const districtShapes = communityDistricts as {
  features: Array<{
    geometry: unknown
    properties: { code: string }
    type: string
  }>
  type: string
}

export function DistrictMap({
  direction,
  districts,
  selectedGeographyId,
}: DistrictMapProps) {
  const districtByCode = useMemo(
    () => new Map(districts.map((district) => [district.code, district])),
    [districts],
  )

  const projectedDistricts = useMemo(() => {
    const projection = geoMercator().fitSize(
      [MAP_WIDTH, MAP_HEIGHT],
      districtShapes as never,
    )
    const pathGenerator = geoPath(projection)

    return districtShapes.features
      .map((feature) => {
        const district = districtByCode.get(feature.properties.code)

        if (!district) {
          return undefined
        }

        return {
          district,
          path: pathGenerator(feature as never) ?? '',
        }
      })
      .filter((entry): entry is { district: DistrictDatum; path: string } => Boolean(entry))
  }, [districtByCode])

  const defaultDistrictId =
    (selectedGeographyId && districts.some((district) => district.id === selectedGeographyId)
      ? selectedGeographyId
      : undefined) ??
    districts.find((district) => district.isFocus)?.id ??
    districts[0]?.id
  const [activeDistrictId, setActiveDistrictId] = useState<string | undefined>(defaultDistrictId)

  useEffect(() => {
    setActiveDistrictId(defaultDistrictId)
  }, [defaultDistrictId])

  const activeDistrict =
    districts.find((district) => district.id === activeDistrictId) ?? districts[0]

  if (!activeDistrict) {
    return null
  }

  return (
    <div className="district-map">
      <div className="district-map__header">
        <div>
          <p className="section-kicker">Community districts</p>
          <h3 className="section-title">Geographic concentration</h3>
        </div>
        <div className="district-map__legend">
          <span>Lower</span>
          <span className="district-map__legend-ramp" />
          <span>Higher</span>
        </div>
      </div>

      <svg
        className="district-map__surface"
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      >
        {projectedDistricts.map(({ district, path }) => {
          const isActive = district.id === activeDistrict.id
          const isFocus = district.isFocus

          return (
            <path
              key={district.id}
              d={path}
              fill={getDistrictTone(direction, district.intensity)}
              stroke={
                isActive
                  ? 'rgba(248, 250, 252, 0.94)'
                  : isFocus
                    ? 'rgba(248, 250, 252, 0.56)'
                    : 'rgba(248, 250, 252, 0.14)'
              }
              strokeWidth={isActive ? 2.2 : isFocus ? 1.3 : 0.9}
              vectorEffect="non-scaling-stroke"
              onMouseEnter={() => setActiveDistrictId(district.id)}
            />
          )
        })}
      </svg>

      <div className="district-map__footer">
        <div>
          <p className="metric-label">Focused district</p>
          <p className="metric-figure">{activeDistrict.label}</p>
        </div>
        <div>
          <p className="metric-label">Actual vs expected</p>
          <p className="metric-figure">
            {formatCount(activeDistrict.actual)} / {formatCount(activeDistrict.expected)}
          </p>
        </div>
        <div>
          <p className="metric-label">Deviation</p>
          <p className="metric-figure">
            {formatDelta(
              ((activeDistrict.actual - activeDistrict.expected) /
                Math.max(1, activeDistrict.expected)) *
                100,
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
