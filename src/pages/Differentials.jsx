import { useMemo, useState } from 'react'
import { ctxFrom, getBootstrap, getFixtures } from '../api/fpl'
import { useAsync } from '../lib/useAsync'
import { fmt, money } from '../lib/format'
import {
  POS,
  differentialScore,
  fixtureRun,
  minutesShare,
  num,
  rotationRisk,
  statusFlag,
} from '../lib/metrics'
import { Chip, ErrorNote, FdrStrip, FlagChip, PosBadge, Spinner } from '../components/Bits'

export default function Differentials() {
  const boot = useAsync(getBootstrap, [])
  const fx = useAsync(getFixtures, [])
  const [own, setOwn] = useState(10)
  const [pos, setPos] = useState(0)
  const [price, setPrice] = useState(0)

  const ctx = useMemo(() => (boot.data ? ctxFrom(boot.data) : null), [boot.data])
  const gwsDone = ctx?.current?.id ?? 0

  const rows = useMemo(() => {
    if (!ctx || !fx.data) return null
    const fromEvent = ctx.next?.id ?? 39
    const runs = new Map()
    for (const tid of ctx.teams.keys()) runs.set(tid, fixtureRun(fx.data, tid, fromEvent, 5))
    return ctx.bs.elements
      .filter(
        p =>
          num(p.selected_by_percent) <= own &&
          p.status !== 'u' &&
          (!pos || p.element_type === pos) &&
          (!price || p.now_cost <= price),
      )
      .map(p => ({ p, run: runs.get(p.team), score: differentialScore(p, runs.get(p.team), gwsDone) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
  }, [ctx, fx.data, own, pos, price, gwsDone])

  if (boot.loading || fx.loading) return <Spinner label="Working the differential" />
  if (boot.error || fx.error || !rows) return <ErrorNote />

  return (
    <div>
      <div className="no-bar -mx-4 mb-2 flex gap-1.5 overflow-x-auto px-4 pb-1">
        {[5, 10, 15, 20].map(v => (
          <Chip key={v} active={own === v} onClick={() => setOwn(v)}>
            &lt;{v}%
          </Chip>
        ))}
        <span className="mx-0.5 w-px shrink-0 self-stretch bg-line" />
        <Chip active={!pos} onClick={() => setPos(0)}>
          ALL
        </Chip>
        {[1, 2, 3, 4].map(t => (
          <Chip key={t} active={pos === t} onClick={() => setPos(t)}>
            {POS[t]}
          </Chip>
        ))}
        <span className="mx-0.5 w-px shrink-0 self-stretch bg-line" />
        <Chip active={!price} onClick={() => setPrice(0)}>
          Any £
        </Chip>
        <Chip active={price === 75} onClick={() => setPrice(75)}>
          ≤7.5
        </Chip>
        <Chip active={price === 60} onClick={() => setPrice(60)}>
          ≤6.0
        </Chip>
      </div>

      <p className="mb-3 text-[0.7rem] leading-snug text-mute">
        Candidates under {own}% ownership, ranked by evidence — projection, form, xGI, fixtures, minutes.
        {gwsDone === 0 && ' Pre-season: leans on FPL projections until real minutes accrue (auto-blends by GW6).'}
      </p>

      <ol className="space-y-2">
        {rows.map(({ p, run }, i) => {
          const flag = statusFlag(p)
          const rot = rotationRisk(p, gwsDone)
          const share = minutesShare(p, gwsDone)
          return (
            <li
              key={p.id}
              className="card rise px-3 py-2.5"
              style={{ animationDelay: `${Math.min(i, 12) * 22}ms` }}
            >
              <div className="flex items-start gap-2.5">
                <span className="mono w-5 shrink-0 pt-0.5 text-right text-sm text-mute">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[0.95rem] font-semibold leading-tight">{p.web_name}</span>
                    <PosBadge pos={POS[p.element_type]} />
                    <span className="text-[0.7rem] text-dim">{ctx.teams.get(p.team)?.short_name}</span>
                    <span className="mono text-[0.7rem] text-dim">{money(p.now_cost)}</span>
                  </div>
                  <div className="mono mt-1 text-[0.66rem] leading-snug text-dim">
                    EP {fmt(p.ep_next)} · FORM {fmt(p.form)} · xGI/90 {fmt(p.expected_goal_involvements_per_90, 2)}
                    {(p.element_type === 2 || p.element_type === 3) &&
                      num(p.defensive_contribution_per_90) > 0 && (
                        <> · DC/90 {fmt(p.defensive_contribution_per_90)}</>
                      )}
                  </div>
                  <div className="mt-1.5">
                    <FdrStrip run={run} teams={ctx.teams} />
                  </div>
                  {(flag || rot) && (
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      <FlagChip flag={flag} />
                      {rot && (
                        <span className="text-[0.68rem] text-warn">
                          Rotation risk — {Math.round((share || 0) * 100)}% of minutes
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <span className="mono shrink-0 text-sm font-semibold text-pitch">
                  {fmt(p.selected_by_percent)}%
                </span>
              </div>
            </li>
          )
        })}
      </ol>
      {rows.length === 0 && (
        <div className="card px-4 py-6 text-center text-sm text-mute">No players match these filters.</div>
      )}
    </div>
  )
}
