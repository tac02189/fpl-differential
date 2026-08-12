import { useMemo } from 'react'
import { ctxFrom, getBootstrap, getFixtures, getPicks } from '../api/fpl'
import { useAsync } from '../lib/useAsync'
import { useSettings } from '../state/SettingsContext'
import { fmt } from '../lib/format'
import { captainScore, fixtureRun, num } from '../lib/metrics'
import { ErrorNote, Spinner } from '../components/Bits'

export default function Captain() {
  const { settings } = useSettings()
  const teamId = settings.teamId
  const boot = useAsync(getBootstrap, [])
  const fx = useAsync(getFixtures, [])
  const ctx = useMemo(() => (boot.data ? ctxFrom(boot.data) : null), [boot.data])
  const gw = ctx?.current?.id ?? null
  const picks = useAsync(() => getPicks(teamId, gw), [teamId, gw], { enabled: !!(teamId && gw) })

  const view = useMemo(() => {
    if (!ctx || !fx.data) return null
    const fromEvent = ctx.next?.id ?? 39
    const runCache = new Map()
    const nextFix = teamId2 => {
      if (!runCache.has(teamId2)) runCache.set(teamId2, fixtureRun(fx.data, teamId2, fromEvent, 1)[0] || null)
      return runCache.get(teamId2)
    }

    let pool
    let note = null
    if (picks.data) {
      pool = picks.data.picks.map(pk => ({ pk, p: ctx.players.get(pk.element) })).filter(x => x.p)
      note = null
    } else {
      pool = ctx.bs.elements.map(p => ({ pk: null, p }))
      note = teamId
        ? 'Your squad is private until the deadline passes — showing the field’s top armband options meanwhile.'
        : 'Link your team ID in settings to rank your own 15 — showing the field’s top options meanwhile.'
    }

    const rows = pool
      .map(({ pk, p }) => ({ pk, p, fix: nextFix(p.team), score: captainScore(p, nextFix(p.team)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, picks.data ? 15 : 10)
    const max = rows[0]?.score || 1
    return { rows, max, note }
  }, [ctx, fx.data, picks.data, teamId])

  if (boot.loading || fx.loading) return <Spinner label="Weighing the armband" />
  if (boot.error || fx.error || !view) return <ErrorNote />

  return (
    <div>
      {view.note && <p className="mb-3 text-[0.72rem] leading-snug text-mute">{view.note}</p>}
      <ol className="space-y-2">
        {view.rows.map(({ pk, p, fix, score }, i) => {
          const ownPct = num(p.selected_by_percent)
          const code = fix ? ctx.teams.get(fix.opp)?.short_name : null
          return (
            <li key={p.id} className="card rise px-3 py-2.5" style={{ animationDelay: `${Math.min(i, 10) * 22}ms` }}>
              <div className="flex items-center gap-2.5">
                <span className="mono w-5 shrink-0 text-right text-sm text-mute">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[0.95rem] font-semibold leading-tight">{p.web_name}</span>
                    {pk?.is_captain && (
                      <span className="mono rounded bg-pitch px-1 text-[0.6rem] font-semibold text-white">C</span>
                    )}
                    {pk?.is_vice_captain && (
                      <span className="mono rounded bg-panel2 px-1 text-[0.6rem] text-dim">V</span>
                    )}
                    <span className="text-[0.7rem] text-dim">{ctx.teams.get(p.team)?.short_name}</span>
                    {fix && code && (
                      <span className={`fdr-${fix.difficulty} mono rounded px-1.5 py-px text-[0.62rem] font-medium`}>
                        {fix.home ? code.toUpperCase() : code.toLowerCase()}
                      </span>
                    )}
                    {ownPct >= 25 && (
                      <span className="mono rounded bg-panel2 px-1.5 py-px text-[0.6rem] text-dim">TEMPLATE</span>
                    )}
                    {ownPct <= 10 && (
                      <span className="mono rounded border border-pitch/40 px-1.5 py-px text-[0.6rem] text-pitch">
                        DIFF
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-panel2">
                    <div className="h-full rounded-full bg-pitchbright" style={{ width: `${(score / view.max) * 100}%` }} />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="mono text-base font-semibold text-ink">{fmt(p.ep_next)}</div>
                  <div className="text-[0.62rem] text-mute">
                    proj · {fmt(p.selected_by_percent)}% own
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
