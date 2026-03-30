import type { Horizon } from '../types'

const compactNumber = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
})

const wholeNumber = new Intl.NumberFormat('en-US')

const percentNumber = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
  signDisplay: 'always',
})

const shortDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
})

const fullDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

export function formatCount(value: number) {
  if (value >= 1000) {
    return compactNumber.format(value)
  }

  return wholeNumber.format(Math.round(value))
}

export function formatDelta(deltaPct: number) {
  return `${percentNumber.format(Math.round(deltaPct))}%`
}

function parseDateValue(value: string) {
  return new Date(value.length === 10 ? `${value}T12:00:00` : value)
}

export function formatDateLabel(value: string) {
  return shortDate.format(parseDateValue(value))
}

export function formatFullDate(value: string) {
  return fullDate.format(parseDateValue(value))
}

export function formatHorizonLabel(horizon: Horizon) {
  switch (horizon) {
    case 'today':
      return 'Today'
    case '7d':
      return '7D'
    case '30d':
      return 'MTD'
    case 'quarter':
      return 'QTD'
    case 'year':
      return 'YTD'
  }
}

export function compactSummary(summary: string, horizon: Horizon) {
  if (horizon === 'today') {
    return summary.replace(/^Today\s+/i, '')
  }

  if (horizon === '7d') {
    return summary.replace(/^The latest week\s+/i, 'Recent complaints ')
  }

  if (horizon === '30d') {
    return summary.replace(/^The (last month|last 30 days|month-like window)\s+/i, 'Recent complaints ')
  }

  if (horizon === 'quarter') {
    return summary.replace(/^Quarter-to-date\s+/i, '')
  }

  return summary.replace(/^Year-to-date\s+/i, '')
}

export function formatPercentile(percentile: number) {
  if (percentile >= 50) {
    return `Top ${Math.max(1, 100 - Math.round(percentile))}%`
  }

  return `Bottom ${Math.max(1, Math.round(percentile))}%`
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
