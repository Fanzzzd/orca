// Why time-boxed: a non-passive window wheel listener makes every scroll wait on the page's main
// thread, so the guard only exists while main is sending a ctrl+wheel (pinch) stream.
const ARMED_MS = 1000

/**
 * Lets the page take a pinch (ctrl+wheel) first, as Chrome does. What the page leaves unhandled
 * is cancelled here, so it neither scrolls the page nor reaches it twice, and main zooms instead.
 */
export function installWheelZoomGuard(args: {
  onArm: (arm: () => void) => void
  armed: () => void
  unhandled: (deltaY: number) => void
}): void {
  let disarmTimer: ReturnType<typeof setTimeout> | null = null
  const guard = (event: WheelEvent): void => {
    // Why bubble phase: the page's own handlers on the target have already run.
    if (!event.ctrlKey || event.defaultPrevented) {
      return
    }
    event.preventDefault()
    args.unhandled(event.deltaY)
  }
  const disarm = (): void => {
    disarmTimer = null
    removeEventListener('wheel', guard)
  }
  args.onArm(() => {
    const wasArmed = disarmTimer !== null
    if (disarmTimer) {
      clearTimeout(disarmTimer)
    }
    disarmTimer = setTimeout(disarm, ARMED_MS)
    if (wasArmed) {
      args.armed()
      return
    }
    addEventListener('wheel', guard, { passive: false })
    // Why two frames: until a commit hands the compositor the new listener, a page with no wheel
    // listener of its own never gets the wheel in the DOM at all.
    requestAnimationFrame(() => requestAnimationFrame(() => args.armed()))
  })
}
