import { useEffect, useState } from 'react'
import { BellOff, BellRing, X } from 'lucide-react'
import { useSettings } from '../state/SettingsContext'
import { disablePush, enablePush, getSubscription, pushSupported } from '../lib/push'
import { buildId, workerBuild } from '../lib/build'

// Shown at the foot of the sheet so a deploy can be checked on the phone itself: the
// build that is running, and whether the service worker in control serves the same one.
// src/lib/build.js says what that check does and does not establish.
const BUILD = buildId()
const WORKER_NOTE = {
  same: 'service worker serves this build',
  differs: 'service worker serves another build — fully close and reopen',
  none: 'no service worker in control',
}

function Field({ label, help, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value.replace(/\D/g, ''))}
        inputMode="numeric"
        placeholder={placeholder}
        className="mono mt-1.5 w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-base text-ink outline-none placeholder:text-mute focus:border-brand/60"
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
  const [worker, setWorker] = useState(null) // same | differs | none | null

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

  // The service-worker check runs when the sheet opens and again if a worker takes control
  // while it is open. Only the newest check may set the line, and none after the sheet
  // closes, so a slow reply cannot overwrite a newer one.
  useEffect(() => {
    if (!sheetOpen || !BUILD) return
    let latest = 0
    const check = () => {
      const n = ++latest
      workerBuild().then(s => n === latest && setWorker(s))
    }
    setWorker(null)
    check()
    const sw = navigator.serviceWorker
    sw?.addEventListener('controllerchange', check)
    return () => {
      latest = -1
      sw?.removeEventListener('controllerchange', check)
    }
  }, [sheetOpen])

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
      <div className="absolute inset-0 bg-ink/40" onClick={closeSheet} />
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
                      ? 'border-pitch/50 bg-pitch/[0.08] text-pitch'
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
                  Deadline reminders 8–24 hours ahead and in the final 8 hours, plus injury news on your
                  players. iPhone needs the app installed to the Home Screen.
                </p>
                {pushError && <p className="mt-1 text-[0.72rem] text-flag">{pushError}</p>}
              </>
            )}
          </div>
          <button
            onClick={save}
            className="display w-full rounded-lg bg-brand py-3 text-base tracking-widest text-white active:bg-branddark"
          >
            Save
          </button>
          <div className="text-center text-mute">
            <p className="text-[0.68rem]">
              Read-only — data via the official FPL API, refreshed every 30 min. Transfers still happen in the FPL
              app.
            </p>
            {BUILD && (
              <p className="mono mt-1 text-[0.62rem]">
                Build {BUILD}
                {WORKER_NOTE[worker] && ` · ${WORKER_NOTE[worker]}`}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
