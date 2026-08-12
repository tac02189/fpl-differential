import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Link2 } from 'lucide-react'
import { ctxFrom, getBootstrap, getEntry, getHistory, getLive, getLiveFixtures, getPicks } from '../api/fpl'
import { useAsync } from '../lib/useAsync'
import { useSettings } from '../state/SettingsContext'
import { countdown, fmtDeadline, fmtK, fmtRank, money } from '../lib/format'
import { POS, statusFlag } from '../lib/metrics'
import { ErrorNote, FlagChip, PosBadge, Section, Spinner, StatTile } from '../components/Bits'

const CHIP_ABBR = { wildcard: 'WC', freehit: 'FH', bboost: 'BB', '3xc': 'TC', manager: 'AM' }

function DeadlineHero({ next }) {
  const [, force] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => force(t => t + 1), 30_000)
    return () => clearInterval(iv)
  }, [])
  if (!next) return null
  const cd = countdown(next.deadline_time)
  return (
    <div className="card ticks px-4 py-4">
      <div className="flex items-baseline justify-between">
        <span className="display text-2xl">GW{next.id}</span>
        <span className="label">deadline</span>
      </div>
      <div className="mono mt-1.5 text-[2.3rem] font-semibold leading-none text-brand">
        {cd.d}d {String(cd.h).padStart(2, '0')}h {String(cd.m).padStart(2, '0')}m
      </div>
      <div className="mt-2 text-sm text-dim">{fmtDeadline(next.deadline_time)} · your time</div>
    </div>
  )
}

function ChipTracker({ defs, used }) {
  const halves = [
    { title: '1st half · GW1–19', items: defs.filter(c => c.start_event < 20) },
    { title: '2nd half · GW20–38', items: defs.filter(c => c.start_event >= 20) },
  ]
  return (
    <div className="card px-3 py-3">
      {halves.map(h => (
        <div key={h.title} className="flex items-center justify-between py-1">
          <span className="text-[0.7rem] text-mute">{h.title}</span>
          <div className="flex gap-1.5">
            {h.items.map(c => {
              const u = used.find(x => x.name === c.name && x.event >= c.start_event && x.event <= c.stop_event)
              return (
                <span
                  key={c.id ?? `${c.name}${c.start_event}`}
                  className={`mono rounded px-1.5 py-0.5 text-[0.66rem] font-medium ${
                    u ? 'bg-panel2 text-mute line-through' : 'border border-pitch/40 text-pitch'
                  }`}
                  title={u ? `Played GW${u.event}` : 'Available'}
                >
                  {CHIP_ABBR[c.name] || c.name}
                </span>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// FPL tie rules: 3/2/1 by BPS rank per fixture, ties share the higher award
function provisionalBonus(fixtures) {
  const bonus = new Map()
  for (const f of fixtures || []) {
    if (!f.started || f.finished) continue
    const bps = (f.stats || []).find(s => s.identifier === 'bps')
    if (!bps) continue
    const all = [...(bps.h || []), ...(bps.a || [])].sort((a, b) => b.value - a.value)
    let award = [3, 2, 1]
    let i = 0
    while (i < all.length && award.length > 0) {
      const tied = all.filter(x => x.value === all[i].value)
      for (const t of tied) bonus.set(t.element, (bonus.get(t.element) || 0) + award[0])
      award = award.slice(tied.length)
      i += tied.length
    }
  }
  return bonus
}

function LivePanel({ ctx, picks, hits, live, liveFx }) {
  const stats = new Map((live.elements || []).map(e => [e.id, e.stats]))
  const bonus = provisionalBonus(liveFx)
  const rows = [...picks].sort((a, b) => a.position - b.position)
  let total = 0
  let pendingBp = 0
  const items = rows.map(pk => {
    const p = ctx.players.get(pk.element)
    const s = stats.get(pk.element) || {}
    const pts = (s.total_points || 0) * pk.multiplier
    const bp = (bonus.get(pk.element) || 0) * pk.multiplier
    total += pts
    pendingBp += bp
    return { pk, p, s, bp }
  })
  const net = total - (hits || 0)
  return (
    <div className="card ticks overflow-hidden">
      <div className="flex items-baseline justify-between px-4 pt-3.5">
        <span className="mono text-[2.1rem] font-semibold leading-none text-live">{net}</span>
        <span className="text-right text-[0.7rem] leading-snug text-dim">
          {pendingBp > 0 ? `+${pendingBp} bonus pending` : 'live points'}
          {hits > 0 && (
            <>
              <br />
              <span className="text-flag">−{hits} transfer hit{hits > 4 ? 's' : ''}</span>
            </>
          )}
        </span>
      </div>
      <ul className="mt-3 divide-y divide-line border-t border-line">
        {items.map(({ pk, p, s, bp }) => {
          if (!p) return null
          const bench = pk.multiplier === 0
          return (
            <li key={pk.element} className={`flex items-center gap-2 px-4 py-1.5 ${bench ? 'opacity-50' : ''}`}>
              <span className="min-w-0 flex-1 truncate text-[0.85rem] font-medium">
                {p.web_name}
                {pk.is_captain && <span className="text-pitch"> (C)</span>}
              </span>
              {bp > 0 && <span className="mono text-[0.66rem] text-live">+{bp}bp</span>}
              <span className="mono w-8 text-right text-[0.7rem] text-mute">{s.minutes ?? 0}′</span>
              <span className="mono w-8 text-right text-[0.9rem] font-semibold">
                {(s.total_points || 0) * (pk.multiplier || 1)}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="px-4 py-2 text-[0.64rem] leading-snug text-mute">
        Provisional — bench autosubs and final bonus apply when the gameweek is settled.
      </p>
    </div>
  )
}

function SquadList({ picks, ctx }) {
  const byId = ctx.players
  const rows = [...picks].sort((a, b) => a.position - b.position)
  return (
    <ul className="card divide-y divide-line">
      {rows.map(pk => {
        const p = byId.get(pk.element)
        if (!p) return null
        const flag = statusFlag(p)
        const net = p.transfers_in_event - p.transfers_out_event
        const bench = pk.position > 11
        return (
          <li key={pk.element} className={`flex items-center gap-2 px-3 py-2 ${bench ? 'opacity-60' : ''}`}>
            <PosBadge pos={POS[p.element_type]} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[0.9rem] font-medium">{p.web_name}</span>
                {pk.is_captain && <span className="mono rounded bg-pitch px-1 text-[0.6rem] font-semibold text-white">C</span>}
                {pk.is_vice_captain && <span className="mono rounded bg-panel2 px-1 text-[0.6rem] text-dim">V</span>}
                <span className="text-[0.68rem] text-mute">{ctx.teams.get(p.team)?.short_name}</span>
              </div>
              {flag && <FlagChip flag={flag} />}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {p.cost_change_event > 0 && <ArrowUp size={12} className="text-pitch" />}
              {p.cost_change_event < 0 && <ArrowDown size={12} className="text-flag" />}
              <span className={`mono w-12 text-right text-[0.7rem] ${net >= 0 ? 'text-pitch' : 'text-flag'}`}>
                {net >= 0 ? '+' : ''}
                {fmtK(net)}
              </span>
              <span className="mono w-11 text-right text-[0.78rem] text-dim">{money(p.now_cost)}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export default function Home() {
  const { settings, openSheet } = useSettings()
  const teamId = settings.teamId
  const boot = useAsync(getBootstrap, [])
  const ctx = useMemo(() => (boot.data ? ctxFrom(boot.data) : null), [boot.data])
  const gw = ctx?.current?.id ?? null
  const entry = useAsync(() => getEntry(teamId), [teamId], { enabled: !!teamId })
  const history = useAsync(() => getHistory(teamId), [teamId], { enabled: !!teamId })
  const picks = useAsync(() => getPicks(teamId, gw), [teamId, gw], { enabled: !!(teamId && gw) })

  // an unfinished current GW = matches in play or upcoming this week → live scoring
  const liveActive = !!(ctx?.current && !ctx.current.finished && gw)
  const live = useAsync(() => getLive(gw), [gw], { enabled: liveActive, poll: 60_000 })
  const liveFx = useAsync(() => getLiveFixtures(gw), [gw], { enabled: liveActive, poll: 120_000 })

  if (boot.loading) return <Spinner label="Reading the game state" />
  if (boot.error || !ctx) return <ErrorNote />

  const e = entry.data
  const chipsUsed = history.data?.chips || []

  return (
    <div className="space-y-5">
      {liveActive && teamId && (
        <Section
          title={`GW${gw} live`}
          right={
            <span className="flex items-center gap-1.5 text-[0.66rem] font-medium tracking-widest text-live">
              <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-live" />
              LIVE
            </span>
          }
        >
          {picks.data && live.data ? (
            <LivePanel
              ctx={ctx}
              picks={picks.data.picks}
              hits={picks.data.entry_history?.event_transfers_cost || 0}
              live={live.data}
              liveFx={liveFx.data}
            />
          ) : picks.loading || live.loading ? (
            <Spinner label="Fetching live points" />
          ) : (
            <div className="card px-4 py-3 text-sm text-dim">Live points appear once the deadline passes.</div>
          )}
        </Section>
      )}

      <Section title="Next deadline">
        <DeadlineHero next={ctx.next} />
      </Section>

      {!teamId && (
        <div className="card rise px-4 py-4">
          <div className="display mb-1 text-base tracking-wider">Link your team</div>
          <p className="mb-3 text-sm leading-snug text-dim">
            Add your FPL team ID to see your squad, chips, injury flags, and captain options. Read-only — no login
            needed.
          </p>
          <button
            onClick={openSheet}
            className="display inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm tracking-widest text-white active:bg-branddark"
          >
            <Link2 size={15} /> Add team ID
          </button>
        </div>
      )}

      {teamId && (
        <Section title={e ? e.name : 'Your team'}>
          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Overall pts" value={e?.summary_overall_points ?? '—'} accent />
            <StatTile label="Overall rank" value={e ? fmtRank(e.summary_overall_rank) : '—'} />
            <StatTile
              label="Team value"
              value={e?.last_deadline_value != null ? money(e.last_deadline_value) : '—'}
            />
            <StatTile label="In the bank" value={e?.last_deadline_bank != null ? money(e.last_deadline_bank) : '—'} />
          </div>
        </Section>
      )}

      <Section title="Chips">
        <ChipTracker defs={ctx.bs.chips || []} used={chipsUsed} />
      </Section>

      {teamId && (
        <Section title="Squad">
          {picks.data ? (
            <SquadList picks={picks.data.picks} ctx={ctx} />
          ) : picks.loading ? (
            <Spinner label="Loading squad" />
          ) : (
            <div className="card px-4 py-3 text-sm leading-snug text-dim">
              FPL keeps squads private until each deadline passes — your team appears here once{' '}
              {ctx.next ? `the GW${ctx.next.id} deadline (${fmtDeadline(ctx.next.deadline_time)})` : 'the deadline'} has
              gone.
            </div>
          )}
        </Section>
      )}
    </div>
  )
}
