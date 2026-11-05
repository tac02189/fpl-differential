// Which build is this page, and does the service worker in control serve the same one?
//
// The page knows its build from the entry script that loaded it. From a controlled page, a
// fetch of /index.html is answered by the service worker in control, out of its precache,
// so the entry script named in that copy is the build the worker serves. This compares them.
//
// What a match shows, and what it does not:
// - When a release changes the app's code, the entry script's name changes with it, so a
//   match means the worker in control serves that release's page.
// - A release that changes only push-sw.js or the worker's own setup keeps the same entry
//   script, and this cannot tell those workers apart. A received test push is the check
//   that matters there, though it shows that delivery works, not which worker handled it.
// - If the worker's cached copy is missing, Workbox fetches the page from the network
//   instead, and an older worker could then report a match.
// - It is one observation. The worker in control can change afterwards.
//
// Production only: the dev server has no service worker and no hashed entry script.
const ENTRY = 'script[type="module"][src*="/assets/"]'
const entryOf = doc => doc.querySelector(ENTRY)?.getAttribute('src') || null

// The entry script's hash, which changes whenever the app's code does.
export function buildId() {
  if (!import.meta.env.PROD) return null
  const src = entryOf(document)
  return src ? src.split('/').pop().replace(/\.js$/, '').replace(/^index-/, '') : null
}

// 'same', 'differs', 'none' (no service worker in control), or null when it cannot tell.
export async function workerBuild() {
  const src = import.meta.env.PROD ? entryOf(document) : null
  if (!src || !('serviceWorker' in navigator)) return null
  if (!navigator.serviceWorker.controller) return 'none'
  try {
    const res = await fetch('/index.html', { cache: 'no-store' })
    if (!res.ok) return null
    const served = entryOf(new DOMParser().parseFromString(await res.text(), 'text/html'))
    if (!served) return null
    return served === src ? 'same' : 'differs'
  } catch {
    return null
  }
}
