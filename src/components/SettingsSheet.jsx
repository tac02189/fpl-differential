import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useSettings } from '../state/SettingsContext'

function Field({ label, help, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value.replace(/\D/g, ''))}
        inputMode="numeric"
        placeholder={placeholder}
        className="mono mt-1.5 w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-base text-ink outline-none placeholder:text-mute focus:border-pitch/60"
      />
      <span className="mt-1 block text-[0.72rem] leading-snug text-mute">{help}</span>
    </label>
  )
}

export default function SettingsSheet() {
  const { settings, update, sheetOpen, closeSheet } = useSettings()
  const [teamId, setTeamId] = useState(settings.teamId)
  const [leagueId, setLeagueId] = useState(settings.leagueId)

  useEffect(() => {
    if (sheetOpen) {
      setTeamId(settings.teamId)
      setLeagueId(settings.leagueId)
    }
  }, [sheetOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!sheetOpen) return null

  const save = () => {
    update({ teamId, leagueId })
    closeSheet()
  }

  return (
    <div className="fixed inset-0 z-30">
      <div className="absolute inset-0 bg-black/60" onClick={closeSheet} />
      <div
        className="rise absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-2xl border-t border-line bg-panel px-5 pt-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="display text-base tracking-wider">Settings</h2>
          <button onClick={closeSheet} aria-label="Close" className="p-1 text-dim">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-4">
          <Field
            label="FPL team ID"
            value={teamId}
            onChange={setTeamId}
            placeholder="e.g. 1234567"
            help="On fantasy.premierleague.com open Points — your ID is the number in the URL after /entry/."
          />
          <Field
            label="Mini-league ID"
            value={leagueId}
            onChange={setLeagueId}
            placeholder="e.g. 98765"
            help="Open your league's standings — the number in the URL after /leagues/. Classic leagues only."
          />
          <button
            onClick={save}
            className="display w-full rounded-lg bg-pitch py-3 text-base tracking-widest text-[#07130d] active:bg-pitchdark"
          >
            Save
          </button>
          <p className="text-center text-[0.68rem] text-mute">
            Read-only — data via the official FPL API, refreshed every 30 min. Transfers still happen in the FPL app.
          </p>
        </div>
      </div>
    </div>
  )
}
