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
      return '30D'
    case 'quarter':
      return 'Quarter'
    case 'year':
      return 'Year'
  }
}

function sentenceCase(value: string) {
  if (!value) {
    return value
  }

  return value[0].toUpperCase() + value.slice(1)
}

export function compactSummary(summary: string, horizon: Horizon) {
  let compact = summary

  if (horizon === 'today') {
    compact = summary
      .replace(/^Today\s+broke\s+/i, 'Daily volume broke ')
      .replace(/^Today\s+fell\s+/i, 'Daily volume fell ')
      .replace(/^Today\s+rose\s+/i, 'Daily volume rose ')
      .replace(/^Today\s+/i, 'Daily volume ')
    return sentenceCase(compact)
  }

  if (horizon === '7d') {
    compact = summary.replace(/^The (latest|last) week\s+/i, 'Weekly volume ')
    return sentenceCase(compact)
  }

  if (horizon === '30d') {
    compact = summary.replace(
      /^The (last month|last 30 days|month-like window)\s+/i,
      '30-day volume ',
    )
    compact = compact.replace(/^30-day volume have\b/i, '30-day volume has')
    return sentenceCase(compact)
  }

  if (horizon === 'quarter') {
    compact = summary.replace(/^Quarter-to-date\s+/i, 'Over the last 90 days, ')
    return sentenceCase(compact)
  }

  compact = summary.replace(/^Year-to-date\s+/i, 'Over the last 12 months, ')
  return sentenceCase(compact)
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
