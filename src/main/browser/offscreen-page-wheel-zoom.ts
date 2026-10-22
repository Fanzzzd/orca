import type { WebContents } from 'electron'
import type { OffscreenPageUserInput } from '../../shared/offscreen-page-protocol'
import { OFFSCREEN_PAGE_GUEST_CHANNELS } from '../../shared/offscreen-page-guest-channels'

/** Renderer channel, sent with the page id and the zoom direction. */
export const OFFSCREEN_PAGE_WHEEL_ZOOM_CHANNEL = 'offscreen-page:wheel-zoom'

// Frame guards stay armed 1s (preload's ARMED_MS); count them lapsed earlier, re-arm before that.
const GUARD_MS = 800
const REARM_AFTER_MS = 400
// Why bounded: a frame without the preload (blank iframe) never acks.
const ARM_ACK_TIMEOUT_MS = 100
// Why throttle: a trackpad pinch arrives as a burst of ctrl+wheel events.
const ZOOM_STEP_INTERVAL_MS = 100

export type OffscreenPageWheelZoom = {
  /** Sends a ctrl+wheel once the page's frames can tell main it went unhandled, in order. */
  dispatch(send: () => unknown): Promise<void>
}

/** A macOS trackpad pinch reaches the DOM as ctrl+wheel, as does ctrl+wheel on other platforms. */
export function isWheelZoomCandidate(
  input: Extract<OffscreenPageUserInput, { kind: 'wheel' }>
): boolean {
  return (
    input.modifiers.includes('control') &&
    !input.modifiers.includes('alt') &&
    !input.modifiers.includes('shift')
  )
}

/**
 * Chrome gives a pinch to the page first (maps zoom themselves) and zooms only when the page leaves
 * it unhandled. The page's frames report that through their guest preload.
 */
export function createOffscreenPageWheelZoom(args: {
  contents: WebContents
  zoom: (direction: 'in' | 'out') => void
}): OffscreenPageWheelZoom {
  const { contents } = args
  let armedAt = Number.NEGATIVE_INFINITY
  let lastZoomAt = Number.NEGATIVE_INFINITY
  let onArmed: (() => void) | null = null
  let queue: Promise<void> = Promise.resolve()

  contents.ipc.on(OFFSCREEN_PAGE_GUEST_CHANNELS.wheelZoomArmed, () => onArmed?.())
  contents.ipc.on(OFFSCREEN_PAGE_GUEST_CHANNELS.wheelZoomUnhandled, (_event, deltaY: unknown) => {
    const now = Date.now()
    if (typeof deltaY !== 'number' || deltaY === 0 || now - lastZoomAt < ZOOM_STEP_INTERVAL_MS) {
      return
    }
    lastZoomAt = now
    args.zoom(deltaY < 0 ? 'in' : 'out')
  })

  const armFrames = (): number => {
    let sent = 0
    for (const frame of contents.mainFrame.framesInSubtree) {
      try {
        frame.send(OFFSCREEN_PAGE_GUEST_CHANNELS.wheelZoomArm)
        sent += 1
      } catch {
        // A frame torn down mid-walk has nothing to guard.
      }
    }
    return sent
  }
  const armAndWait = (): Promise<void> =>
    new Promise((resolve) => {
      let waiting = armFrames()
      const done = (): void => {
        clearTimeout(timer)
        onArmed = null
        resolve()
      }
      const timer = setTimeout(done, ARM_ACK_TIMEOUT_MS)
      onArmed = () => {
        waiting -= 1
        if (waiting <= 0) {
          done()
        }
      }
      if (waiting === 0) {
        done()
      }
    })

  return {
    dispatch(send) {
      const run = async (): Promise<void> => {
        if (contents.isDestroyed()) {
          return
        }
        const since = Date.now() - armedAt
        // Why wait on the first event: the guard must be in place before the page sees it, or the
        // unhandled wheel scrolls the page.
        if (since >= GUARD_MS) {
          await armAndWait()
          armedAt = Date.now()
        } else if (since >= REARM_AFTER_MS) {
          armFrames()
          armedAt = Date.now()
        }
        if (!contents.isDestroyed()) {
          await send()
        }
      }
      queue = queue.then(run, run)
      return queue
    }
  }
}
