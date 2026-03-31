import type { AlertRecord, DashboardData, EntityRecord } from '../types'

const DASHBOARD_INDEX_URL = '/data/dashboard-index.json'

export async function fetchDashboardIndex() {
  const response = await fetch(DASHBOARD_INDEX_URL)

  if (!response.ok) {
    throw new Error(`Failed to load dashboard index: ${response.status}`)
  }

  return response.json() as Promise<DashboardData>
}

export async function fetchAlertDetail(alertId: string) {
  const response = await fetch(`/data/alerts/${encodeURIComponent(alertId)}.json`)

  if (!response.ok) {
    throw new Error(`Failed to load alert detail: ${response.status}`)
  }

  return response.json() as Promise<AlertRecord>
}

export async function fetchEntityDetail(entityId: string) {
  const response = await fetch(`/data/entities/${slugify(entityId)}.json`)

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
