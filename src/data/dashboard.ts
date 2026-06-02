import type { AlertRecord, DashboardData, EntityRecord } from '../types'

const DATA_BASE_URL = `${import.meta.env.BASE_URL}data`
const DASHBOARD_INDEX_URL = `${DATA_BASE_URL}/dashboard-index.json`

export async function fetchDashboardIndex() {
  const response = await fetch(DASHBOARD_INDEX_URL)

  if (!response.ok) {
    throw new Error(`Failed to load dashboard index: ${response.status}`)
  }

  return response.json() as Promise<DashboardData>
}

export async function fetchAlertDetail(alertId: string) {
  const response = await fetch(`${DATA_BASE_URL}/alerts/${encodeURIComponent(alertId)}.json`)

  if (!response.ok) {
    throw new Error(`Failed to load alert detail: ${response.status}`)
  }

  return response.json() as Promise<AlertRecord>
}

export async function fetchEntityDetail(entityId: string) {
  const response = await fetch(`${DATA_BASE_URL}/entities/${entityFileSlug(entityId)}.json`)

  if (!response.ok) {
    throw new Error(`Failed to load entity detail: ${response.status}`)
  }

  return response.json() as Promise<EntityRecord>
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120)
}

function entityFileSlug(value: string) {
  return `${slugify(value)}-${hashString(value)}`
}

function hashString(value: string) {
  let hash = 2_166_136_261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }

  return (hash >>> 0).toString(36)
}
