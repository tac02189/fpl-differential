import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Link2, Minus } from 'lucide-react'
import { ctxFrom, getBootstrap, getLeague, getPicks } from '../api/fpl'
import { useAsync } from '../lib/useAsync'
import { useSettings } from '../state/SettingsContext'
import { fmtRank } from '../lib/format'
import { POS } from '../lib/metrics'
import { ErrorNote, PosBadge, Section, Spinner } from '../components/Bits'

function Movement({ rank, last }) {
  if (!last || rank === last) return <Minus size={11} className="text-mute" />
  return rank < last ? <ArrowUp size={11} className="text-pitch" /> : <ArrowDown size={11} className="text-flag" />
}

export default function Rivals() {
  const { settings, openSheet } = useSettings()
  const { teamId, leagueId } = settings
  const boot = useAsync(getBootstrap, [])
  const league = useAsync(() => getLeague(leagueId), [leagueId], { enabled: !!leagueId })
  const ctx = useMemo(() => (boot.data ? ctxFrom(boot.data) : null), [boot.data])
  const gw = ctx?.current?.id ?? null
  const standings = league.data?.standings?.results ?? null

  // rival squads for the current GW (public once the deadline passes)
  const [squads, setSquads] = useState(null)
  useEffect(() => {
    if (!standings || !gw || standings.length === 0) {
      setSquads(null)
      return
    }
    let dead = false
    const targets = standings.slice(0, 9)
    Promise.all(
      targets.map(r =>
        getPicks(r.entry, gw).then(
          d => ({ entry: r.entry, name: r.entry_name, picks: d.picks }),
          () => null,
        ),
      ),
    ).then(res => !dead && setSquads(res.filter(Boolean)))
    return () => {
      dead = true
    }
  }, [standings, gw])

  const matrix = useMemo(() => {
    if (!squads || !ctx) return null
    const mine = squads.find(s => String(s.entry) === String(teamId))
    const rivals = squads.filter(s => String(s.entry) !== String(teamId))
    if (!mine || rivals.length === 0) return null
    const myIds = new Set(mine.picks.map(p => p.element))
    const counts = new Map()
    for (const r of rivals) for (const pk of r.picks) counts.set(pk.element, (counts.get(pk.element) || 0) + 1)
    const theyHave = [...counts.entries()]
      .filter(([id]) => !myIds.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, n]) => ({ p: ctx.players.get(id), n }))
      .filter(x => x.p)
    const myEdges = mine.picks
      .filter(pk => !counts.has(pk.element))
      .map(pk => ctx.players.get(pk.element))
      .filter(Boolean)
    return { theyHave, myEdges, nRivals: rivals.length }
  }, [squads, ctx, teamId])

  if (!leagueId) {
    return (
      <div className="card rise px-4 py-4">
        <div className="display mb-1 text-base tracking-wider">Track your mini-league</div>
        <p className="mb-3 text-sm leading-snug text-dim">
          Add your classic league ID to see standings, what your rivals own that you don’t, and where your edges are.
        </p>
        <button
          onClick={openSheet}
          className="display inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm tracking-widest text-white active:bg-branddark"
        >
          <Link2 size={15} /> Add league ID
        </button>
      </div>
    )
  }

  if (boot.loading || league.loading) return <Spinner label="Scouting the league" />
  if (boot.error || league.error) return <ErrorNote note="Check the league ID — it must be a classic league." />

  return (
    <div className="space-y-5">
      <Section title={league.data?.league?.name || 'Standings'}>
        <ul className="card divide-y divide-line">
          {(standings || []).slice(0, 12).map(r => {
            const me = String(r.entry) === String(teamId)
            return (
              <li
                key={r.entry}
                className={`flex items-center gap-2 px-3 py-2 ${me ? 'bg-brand/[0.06]' : ''}`}
              >
                <span className="mono w-5 shrink-0 text-right text-[0.78rem] text-dim">{r.rank}</span>
                <Movement rank={r.rank} last={r.last_rank} />
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[0.88rem] ${me ? 'font-semibold text-brand' : 'font-medium'}`}>
                    {r.entry_name}
                  </div>
                  <div className="truncate text-[0.66rem] text-mute">{r.player_name}</div>
                </div>
                <span className="mono shrink-0 text-[0.85rem] font-semibold">{fmtRank(r.total)}</span>
              </li>
            )
          })}
          {(standings || []).length === 0 && (
            <li className="px-4 py-4 text-sm text-mute">No standings yet — they appear once the season starts.</li>
          )}
        </ul>
      </Section>

      {!gw && (
        <p className="text-[0.72rem] leading-snug text-mute">
          Rival squads are public after each deadline — the differential matrix lights up once GW1 kicks off.
        </p>
      )}

      {matrix && (
        <>
          <Section title={`They have, you don’t · top ${matrix.theyHave.length}`}>
            <ul className="card divide-y divide-line">
              {matrix.theyHave.map(({ p, n }) => (
                <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                  <PosBadge pos={POS[p.element_type]} />
                  <span className="min-w-0 flex-1 truncate text-[0.88rem] font-medium">{p.web_name}</span>
                  <span className="text-[0.68rem] text-mute">{ctx.teams.get(p.team)?.short_name}</span>
                  <span className="mono rounded bg-panel2 px-1.5 py-0.5 text-[0.66rem] text-warn">
                    {n}/{matrix.nRivals} rivals
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Your edges — no rival owns these">
            <ul className="card divide-y divide-line">
              {matrix.myEdges.map(p => (
                <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                  <PosBadge pos={POS[p.element_type]} />
                  <span className="min-w-0 flex-1 truncate text-[0.88rem] font-medium">{p.web_name}</span>
                  <span className="text-[0.68rem] text-mute">{ctx.teams.get(p.team)?.short_name}</span>
                  <span className="mono text-[0.7rem] text-pitch">{p.selected_by_percent}%</span>
                </li>
              ))}
              {matrix.myEdges.length === 0 && (
                <li className="px-4 py-3 text-sm text-mute">None yet — your squad overlaps every rival.</li>
              )}
            </ul>
          </Section>
        </>
      )}
    </div>
  )
}
