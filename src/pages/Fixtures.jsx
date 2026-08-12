import { useMemo, useState } from 'react'
import { ctxFrom, getBootstrap, getFixtures } from '../api/fpl'
import { useAsync } from '../lib/useAsync'
import { fixtureRun, hasStrengthSplits, strengthBander } from '../lib/metrics'
import { Chip, ErrorNote, Spinner } from '../components/Bits'

const MODES = [
  { id: 'fdr', label: 'FDR', hint: 'Overall fixture difficulty (official FPL ratings).' },
  { id: 'att', label: 'ATT', hint: 'For your attackers — how soft each opponent’s defence is.' },
  { id: 'def', label: 'DEF', hint: 'For your defence — how blunt each opponent’s attack is.' },
]

export default function Fixtures() {
  const boot = useAsync(getBootstrap, [])
  const fx = useAsync(getFixtures, [])
  const [mode, setMode] = useState('fdr')
  const [byEase, setByEase] = useState(true)

  const ctx = useMemo(() => (boot.data ? ctxFrom(boot.data) : null), [boot.data])

  // FPL publishes attack/defence ratings only once the season is underway, and
  // may publish one side before the other — so check each mode independently
  const ready = useMemo(
    () => ({
      fdr: true,
      att: ctx ? hasStrengthSplits(ctx.teams, 'att') : false,
      def: ctx ? hasStrengthSplits(ctx.teams, 'def') : false,
    }),
    [ctx],
  )
  const activeMode = ready[mode] ? mode : 'fdr'

  const view = useMemo(() => {
    if (!ctx || !fx.data) return null
    const start = ctx.next?.id ?? 38
    const events = []
    for (let e = start; e <= Math.min(38, start + 5); e++) events.push(e)
    const last = events[events.length - 1]
    const bander = activeMode === 'fdr' ? null : strengthBander(ctx.teams, activeMode)
    const rows = [...ctx.teams.values()].map(t => {
      const run = fixtureRun(fx.data, t.id, start, 99).filter(f => f.event <= last)
      const cells = events.map(e =>
        run
          .filter(f => f.event === e)
          .map(f => ({ ...f, d: bander ? bander(f.opp, !f.home) : f.difficulty })),
      )
      const easeSum = cells.flat().reduce((s, c) => s + (6 - c.d), 0)
      return { t, cells, easeSum }
    })
    rows.sort(byEase ? (a, b) => b.easeSum - a.easeSum : (a, b) => a.t.short_name.localeCompare(b.t.short_name))
    return { events, rows }
  }, [ctx, fx.data, activeMode, byEase])

  if (boot.loading || fx.loading) return <Spinner label="Charting the run-ins" />
  if (boot.error || fx.error || !view) return <ErrorNote />

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        {MODES.map(m => {
          const locked = !ready[m.id]
          return (
            <Chip
              key={m.id}
              active={activeMode === m.id}
              disabled={locked}
              onClick={() => setMode(m.id)}
              title={locked ? 'FPL publishes attack/defence ratings once the season starts' : undefined}
            >
              {m.label}
            </Chip>
          )
        })}
        <div className="flex-1" />
        <Chip active={byEase} onClick={() => setByEase(!byEase)}>
          {byEase ? 'easiest first' : 'A–Z'}
        </Chip>
      </div>
      <p className="mb-3 text-[0.7rem] leading-snug text-mute">
        {MODES.find(m => m.id === activeMode)?.hint}
        {(!ready.att || !ready.def) && (
          <>
            {' '}
            <span className="text-warn">
              {!ready.att && !ready.def ? 'ATT and DEF unlock' : `${!ready.att ? 'ATT' : 'DEF'} unlocks`} once FPL
              publishes team attack/defence ratings — they’re all zero until the season starts.
            </span>
          </>
        )}
      </p>

      <div className="card overflow-hidden rise">
        <div className="grid" style={{ gridTemplateColumns: `52px repeat(${view.events.length}, 1fr)` }}>
          <div className="border-b border-line px-2 py-1.5" />
          {view.events.map(e => (
            <div key={e} className="label border-b border-line py-1.5 text-center !text-[0.6rem]">
              {e}
            </div>
          ))}
          {view.rows.map(({ t, cells }) => (
            <Row key={t.id} t={t} cells={cells} teams={ctx.teams} />
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {[1, 2, 3, 4, 5].map(d => (
          <span key={d} className={`fdr-${d} mono rounded px-1.5 py-0.5 text-[0.62rem] font-medium`}>
            {d}
          </span>
        ))}
        <span className="text-[0.66rem] text-mute">1 easy → 5 hard · CAPS home, lower away</span>
      </div>
    </div>
  )
}

function Row({ t, cells, teams }) {
  return (
    <>
      <div className="mono flex items-center border-b border-line px-2 py-0.5 text-[0.7rem] font-medium text-dim">
        {t.short_name}
      </div>
      {cells.map((fs, i) => (
        <div key={i} className="border-b border-line p-[2px]">
          {fs.length === 0 ? (
            <div className="flex h-full min-h-6 items-center justify-center rounded bg-panel2 text-[0.62rem] text-mute">
              —
            </div>
          ) : (
            <div className="flex h-full flex-col gap-[2px]">
              {fs.map((f, j) => {
                const code = teams.get(f.opp)?.short_name || '???'
                return (
                  <div key={j} className={`fdr-${f.d} flex flex-1 items-center justify-center rounded py-0.5`}>
                    <span className="mono text-[0.62rem] font-medium">
                      {f.home ? code.toUpperCase() : code.toLowerCase()}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </>
  )
}
