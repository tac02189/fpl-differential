import React from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'
import './index.css'

// One reload at most, whichever of the two paths below asks first.
let reloading = false
const reload = () => {
  if (reloading) return
  reloading = true
  window.location.reload()
}

// Browsers check for a new service worker by themselves on a navigation to a page in its
// scope, and on events such as push when a day has passed since the last check. iOS often
// resumes a Home Screen app instead of relaunching it, which is no navigation, so a resumed
// app could keep an old build (after a rollback, the bad one) for as long as iOS kept it in
// memory. So check each time the app returns to the foreground. One check at a time: a
// return during a check queues one more, run when it settles if the app is still in the
// foreground. Offline, update() rejects, and that is ignored; nothing retries a failure
// by itself. A new worker installs, and once it takes control the page reloads.
registerSW({
  immediate: true,
  onNeedReload: reload, // autoUpdate's own reload, through workbox-window
  onRegisteredSW(_url, reg) {
    if (!reg) return
    let busy = false
    let again = false
    const check = () => {
      if (document.visibilityState !== 'visible') return
      if (busy) {
        again = true
        return
      }
      busy = true
      reg
        .update()
        .catch(() => {})
        .finally(() => {
          busy = false
          if (again) {
            again = false
            check()
          }
        })
    }
    document.addEventListener('visibilitychange', check)
  },
})

// Also reload whenever a new worker takes control of a page that already had one.
// workbox-window stops watching for new workers after the first one it did not start
// itself, so if that one fails to install, a later one that succeeds takes control and
// workbox-window never asks for the reload. The first time an uncontrolled page gains a
// worker is skipped, as that is the first install. Not repaired here: a deploy landing
// between this page loading and its first worker installing, or a new worker taking
// control before this code runs. Settings can show either as "serves another build".
if ('serviceWorker' in navigator) {
  let controlled = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled) reload()
    controlled = true
  })
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
