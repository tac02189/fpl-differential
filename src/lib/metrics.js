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

// Band values into 1..5 by midrank percentile — midrank rather than a strict
// less-than count so tied groups sit at their true centre instead of being
// pushed to the easy end. Higher value in = harder band out.
function bandByPercentile(values) {
  const all = [...values].sort((a, b) => a - b)
  const bands = new Map()
  for (const v of new Set(all)) {
    const below = all.filter(x => x < v).length
    const equal = all.filter(x => x === v).length
    bands.set(v, 1 + Math.min(4, Math.floor(((below + equal / 2) / all.length) * 5)))
  }
  return bands
}

export const MIN_RATED_MATCHES = 3

// FPL's granular ratings (strength_attack_*/strength_defence_*) are dead fields:
// they read 0 for every team pre-season AND three gameweeks in, with
// team.strength null throughout. Attack/defence difficulty is therefore derived
// from actual played football — team xG scored per match, and xG conceded per 90.
export function computeTeamRatings(bs, fixtures) {
  const out = new Map()
  for (const t of bs.teams) out.set(t.id, { mp: 0, xg: 0, xgPerMatch: 0, xgcPer90: 0 })

  for (const f of fixtures || []) {
    if (!f.finished) continue
    const h = out.get(f.team_h)
    const a = out.get(f.team_a)
    if (h) h.mp++
    if (a) a.mp++
  }

  // xG scored sums cleanly across a squad; xG conceded accrues per player while
  // they are on the pitch, so the minutes leader carries the closest thing to
  // the team's own figure.
  const anchor = new Map()
  for (const p of bs.elements) {
    const t = out.get(p.team)
    if (!t) continue
    t.xg += num(p.expected_goals)
    const best = anchor.get(p.team)
    if (!best || p.minutes > best.minutes) anchor.set(p.team, p)
  }
  for (const [teamId, p] of anchor) {
    if (p.minutes > 0) out.get(teamId).xgcPer90 = num(p.expected_goals_conceded) / (p.minutes / 90)
  }
  for (const t of out.values()) t.xgPerMatch = t.mp > 0 ? t.xg / t.mp : 0
  return out
}

export const ratedMatches = ratings =>
  ratings && ratings.size ? Math.min(...[...ratings.values()].map(r => r.mp)) : 0

// Sides score more and concede less at home. A flat ~10% edge is the long-run
// Premier League figure; FPL's strength_overall_home/away can't supply it —
// most clubs are rated HIGHER away there, so it isn't team strength by venue.
const HOME_EDGE = 1.1

// ATT asks how good a fixture is for MY attackers, so it rates the opponent's
// DEFENCE; DEF rates the opponent's ATTACK. Null until enough football is played.
export function ratingBander(ratings, mode) {
  if (!ratings || !ratings.size || !['att', 'def'].includes(mode)) return null
  if (ratedMatches(ratings) < MIN_RATED_MATCHES) return null

  // difficulty value: higher = tougher fixture for my players
  const valueFor = (r, oppAtHome) =>
    mode === 'att'
      ? -(r.xgcPer90 * (oppAtHome ? 1 / HOME_EDGE : HOME_EDGE)) // tighter at home; leaky defence = easy = low value
      : r.xgPerMatch * (oppAtHome ? HOME_EDGE : 1 / HOME_EDGE) // more potent at home = harder = high value

  const values = []
  for (const r of ratings.values()) values.push(valueFor(r, true), valueFor(r, false))
  if (new Set(values).size < 2) return null
  const bands = bandByPercentile(values)

  return (oppId, oppAtHome) => {
    const r = ratings.get(oppId)
    if (!r) return 3
    return bands.get(valueFor(r, oppAtHome)) ?? 3
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
