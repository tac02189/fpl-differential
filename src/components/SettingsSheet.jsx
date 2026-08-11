import { useEffect, useState } from 'react'
import { BellOff, BellRing, X } from 'lucide-react'
import { useSettings } from '../state/SettingsContext'
import { disablePush, enablePush, getSubscription, pushSupported } from '../lib/push'

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
  const [push, setPush] = useState('unknown') // on | off | busy | unavailable
  const [pushError, setPushError] = useState(null)

  useEffect(() => {
    if (sheetOpen) {
      setTeamId(settings.teamId)
      setLeagueId(settings.leagueId)
      setPushError(null)
      if (!pushSupported()) setPush('unavailable')
      else
        getSubscription().then(
          s => setPush(s ? 'on' : 'off'),
          () => setPush('off'),
        )
    }
  }, [sheetOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!sheetOpen) return null

  const togglePush = async () => {
    setPushError(null)
    setPush('busy')
    try {
      if (push === 'on') {
        await disablePush()
        setPush('off')
      } else {
        await enablePush(teamId)
        setPush('on')
      }
    } catch (e) {
      setPushError(e.message)
      getSubscription().then(s => setPush(s ? 'on' : 'off'))
    }
  }

  const save = async () => {
    update({ teamId, leagueId })
    // keep the alert registration pointed at the latest team ID; decide from the
    // real subscription (not the async UI state, which may still be 'unknown')
    let sub = null
    if (pushSupported()) {
      try {
        sub = await getSubscription()
      } catch {
        sub = null
      }
    }
    if (sub) {
      setPush('busy')
      try {
        await enablePush(teamId)
        setPush('on')
      } catch (e) {
        // keep the sheet open so the failure is actually seen
        setPush('on')
        setPushError(`Saved, but alert re-registration failed: ${e.message}`)
        return
      }
    }
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
          <div>
            <span className="label">Alerts</span>
            {push === 'unavailable' ? (
              <p className="mt-1.5 text-[0.72rem] leading-snug text-mute">
                Push alerts activate on the deployed app. On iPhone, add it to your Home Screen first.
              </p>
            ) : (
              <>
                <button
                  onClick={togglePush}
                  disabled={push === 'busy' || push === 'unknown'}
                  className={`mt-1.5 flex w-full items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                    push === 'on'
                      ? 'border-pitch/50 bg-pitch/10 text-pitch'
                      : 'border-line bg-panel2 text-ink active:bg-panel'
                  }`}
                >
                  {push === 'on' ? <BellRing size={15} /> : <BellOff size={15} />}
                  {push === 'busy'
                    ? 'Working…'
                    : push === 'on'
                      ? 'Alerts on — tap to disable'
                      : 'Enable deadline & injury alerts'}
                </button>
                <p className="mt-1 text-[0.72rem] leading-snug text-mute">
                  Deadline reminders 24h and 2h out, plus injury news on your players. iPhone needs the app installed
                  to the Home Screen.
                </p>
                {pushError && <p className="mt-1 text-[0.72rem] text-flag">{pushError}</p>}
              </>
            )}
          </div>
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
