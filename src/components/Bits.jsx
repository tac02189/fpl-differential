import { AlertTriangle, Loader2 } from 'lucide-react'

export const Spinner = ({ label = 'Loading' }) => (
  <div className="flex items-center justify-center gap-2 py-12 text-mute">
    <Loader2 size={15} className="animate-spin" />
    <span className="label">{label}</span>
  </div>
)

export const ErrorNote = ({ note = 'Could not reach the FPL API. Pull to refresh or try again shortly.' }) => (
  <div className="card border-flag/40 px-4 py-3 text-sm text-dim">
    <span className="text-flag font-medium">Connection problem — </span>
    {note}
  </div>
)

export const Section = ({ title, right, children, className = '' }) => (
  <section className={`rise ${className}`}>
    <div className="mb-2 flex items-baseline justify-between">
      <h2 className="label">{title}</h2>
      {right}
    </div>
    {children}
  </section>
)

export const StatTile = ({ label, value, sub, accent = false }) => (
  <div className="card min-w-0 flex-1 px-3 py-2.5">
    <div className="label !text-[0.6rem]">{label}</div>
    <div className={`mono text-xl font-semibold leading-tight ${accent ? 'text-pitch' : 'text-ink'}`}>{value}</div>
    {sub != null && <div className="truncate text-[0.7rem] text-dim">{sub}</div>}
  </div>
)

// CAPS = home fixture, lowercase = away (classic ticker convention)
export const FdrStrip = ({ run, teams }) => (
  <div className="flex gap-[3px]">
    {run.map((f, i) => {
      const code = teams.get(f.opp)?.short_name || '???'
      return (
        <div key={i} className={`fdr-${f.difficulty} min-w-9 rounded px-1 py-[3px] text-center`}>
          <span className="mono text-[0.62rem] font-medium">{f.home ? code.toUpperCase() : code.toLowerCase()}</span>
        </div>
      )
    })}
    {run.length === 0 && <span className="text-[0.68rem] text-mute">no fixtures</span>}
  </div>
)

export const FlagChip = ({ flag }) =>
  flag ? (
    <span
      className={`inline-flex items-center gap-1 text-[0.68rem] leading-tight ${
        flag.kind === 'flag' ? 'text-flag' : 'text-warn'
      }`}
    >
      <AlertTriangle size={11} className="shrink-0" />
      <span className="min-w-0">{flag.text}</span>
    </span>
  ) : null

export const Chip = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`shrink-0 rounded-full border px-3 py-1 text-[0.72rem] font-medium transition-colors ${
      active
        ? 'border-pitch/60 bg-pitch/15 text-pitch'
        : 'border-line bg-panel text-dim active:bg-panel2'
    }`}
  >
    {children}
  </button>
)

export const PosBadge = ({ pos }) => (
  <span className="mono rounded bg-panel2 px-1 py-px text-[0.6rem] font-medium text-dim">{pos}</span>
)
