export const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' }

export const num = x => parseFloat(x) || 0

// Upcoming fixtures for a team, ordered, next n.
export function fixtureRun(fixtures, teamId, fromEvent, n = 5) {
  const out = []
  for (const f of fixtures) {
    if (f.event == null || f.event < fromEvent || f.finished) continue
    if (f.team_h !== teamId && f.team_a !== teamId) continue
    const home = f.team_h === teamId
    out.push({
      event: f.event,
      opp: home ? f.team_a : f.team_h,
      home,
      difficulty: home ? f.team_h_difficulty : f.team_a_difficulty,
    })
  }
  out.sort((a, b) => a.event - b.event)
  return out.slice(0, n)
}

// Average ease of a run: 1 = brutal, 5 = cushy.
export const ease = run => (run.length ? run.reduce((s, f) => s + (6 - f.difficulty), 0) / run.length : 0)

const chanceFactor = p => {
  const c = p.chance_of_playing_next_round
  return c == null ? 1 : c / 100
}

// Share of available minutes actually played this season.
export const minutesShare = (p, gwsDone) => (gwsDone > 0 ? p.minutes / (gwsDone * 90) : null)

export const rotationRisk = (p, gwsDone) => {
  const share = minutesShare(p, gwsDone)
  return gwsDone >= 3 && share != null && share < 0.6
}

// Core ranking for the Differentials board.
// Early season there's no form/xGI signal, so lean on FPL's own projection
// (ep_next, seeded from last season) and blend toward real underlying stats by GW6.
export function differentialScore(p, run, gwsDone) {
  const blend = Math.min(1, gwsDone / 6)
  // capped: tiny-sample per-90s (a sub's one cameo) produce nonsense rates
  const xgi90 = Math.min(1.5, num(p.expected_goal_involvements_per_90))
  const def90 = p.element_type === 2 || p.element_type === 3 ? Math.min(20, num(p.defensive_contribution_per_90)) : 0
  const share = minutesShare(p, gwsDone)
  // how much to trust per-90 rates: real minutes share in-season;
  // pre-season, FPL's own projection is the only availability signal
  const rel = share == null ? Math.max(0, Math.min(1, (num(p.ep_next) - 1.5) / 2)) : Math.min(1, share / 0.6)
  const evidence = num(p.form) * 1.1 * blend + (xgi90 * 3.2 + def90 * 0.3) * rel
  const projection = num(p.ep_next) * (1.6 - 1.2 * blend)
  const fx = run.length ? (ease(run) - 3) * 0.85 : 0
  const minsFactor = share == null ? chanceFactor(p) : (0.35 + 0.65 * Math.min(1, share / 0.75)) * chanceFactor(p)
  return (evidence + projection + fx) * minsFactor
}

export function captainScore(p, fix) {
  let s = num(p.ep_next) * 2 + num(p.form) * 0.8
  if (fix) s += (5 - fix.difficulty) * 0.6 + (fix.home ? 0.4 : 0)
  return s * chanceFactor(p)
}

// Attack/defense-specific difficulty bands for the Fixtures grid.
// Band an opponent's venue-specific strength into 1..5 across the league.
export function strengthBander(teams, mode) {
  const keyH = mode === 'att' ? 'strength_defence_home' : 'strength_attack_home'
  const keyA = mode === 'att' ? 'strength_defence_away' : 'strength_attack_away'
  const all = []
  for (const t of teams.values()) all.push(t[keyH], t[keyA])
  all.sort((a, b) => a - b)
  return (oppId, oppAtHome) => {
    const opp = teams.get(oppId)
    const v = oppAtHome ? opp[keyH] : opp[keyA]
    const below = all.filter(x => x < v).length
    return 1 + Math.min(4, Math.floor((below / all.length) * 5))
  }
}

export function statusFlag(p) {
  if (p.status === 'i') return { kind: 'flag', text: p.news || 'Injured' }
  if (p.status === 's') return { kind: 'flag', text: p.news || 'Suspended' }
  if (p.status === 'u') return { kind: 'flag', text: p.news || 'Unavailable' }
  if (p.status === 'd') {
    const c = p.chance_of_playing_next_round
    return { kind: 'warn', text: p.news || (c != null ? `${c}% chance of playing` : 'Doubtful') }
  }
  return null
}
