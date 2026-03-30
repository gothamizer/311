interface SparklineProps {
  direction?: 'up' | 'down'
  values: number[]
}

function buildPath(values: number[]) {
  if (values.length === 0) {
    return ''
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(1, max - min)

  return values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * 100
      const y = 28 - ((value - min) / range) * 24
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

export function Sparkline({ direction = 'up', values }: SparklineProps) {
  const path = buildPath(values)
  const area = `${path} L 100 32 L 0 32 Z`

  return (
    <svg
      aria-hidden="true"
      className={`sparkline sparkline--${direction}`}
      preserveAspectRatio="none"
      viewBox="0 0 100 32"
    >
      <path className="sparkline__area" d={area} />
      <path className="sparkline__line" d={path} />
    </svg>
  )
}
