export const money = c => `£${(c / 10).toFixed(1)}`

export const fmt = (x, d = 1) => (parseFloat(x) || 0).toFixed(d)

export const fmtK = n => {
  const a = Math.abs(n)
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (a >= 1_000) return `${(n / 1_000).toFixed(a >= 100_000 ? 0 : 1)}k`
  return `${n}`
}

export const fmtRank = n => (n == null ? '—' : n.toLocaleString('en-US'))

export const fmtDeadline = iso =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))

export function countdown(iso) {
  const ms = new Date(iso) - Date.now()
  const t = Math.max(0, ms)
  return {
    past: ms <= 0,
    d: Math.floor(t / 86_400_000),
    h: Math.floor((t % 86_400_000) / 3_600_000),
    m: Math.floor((t % 3_600_000) / 60_000),
  }
}
