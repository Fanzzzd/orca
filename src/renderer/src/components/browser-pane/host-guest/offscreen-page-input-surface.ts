import type { OffscreenPageUserInput } from '../../../../../shared/offscreen-page-protocol'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { APP_MENU_SELECTION_ACTION_EVENT } from '@/lib/app-menu-selection-actions'

type Modifier = 'shift' | 'control' | 'alt' | 'meta'
type EditAction = 'copy' | 'cut' | 'paste' | 'selectAll' | 'undo' | 'redo'

export type OffscreenPageInputSink = {
  input(input: OffscreenPageUserInput): void
  edit(action: EditAction): void
  focusPage(): void
  /** Tells main whether Orca's keys belong to the page, so page chords act on it. */
  setKeyboardFocus(focused: boolean): void
  /** Ctrl/Cmd+wheel zooms the page through Orca's page zoom, as it does over a <webview>. */
  zoom(direction: 'in' | 'out'): void
  /** Re-reads the page caret; resolves to element-relative CSS px or null. */
  readCaret(): Promise<{ x: number; y: number; height: number } | null>
}

const BUTTONS = ['left', 'middle', 'right'] as const

const CURSOR_CSS: Record<string, string> = {
  hand: 'pointer',
  ibeam: 'text',
  crosshair: 'crosshair',
  move: 'move',
  wait: 'wait',
  progress: 'progress',
  'not-allowed': 'not-allowed',
  grab: 'grab',
  grabbing: 'grabbing',
  'col-resize': 'col-resize',
  'row-resize': 'row-resize',
  help: 'help'
}

/** CSS cursor for an Electron `cursor-changed` type. */
export function cssCursorFor(cursorType: string): string {
  return CURSOR_CSS[cursorType] ?? 'default'
}

function modifiersOf(event: MouseEvent | KeyboardEvent): Modifier[] {
  const modifiers: Modifier[] = []
  if (event.shiftKey) {
    modifiers.push('shift')
  }
  if (event.ctrlKey) {
    modifiers.push('control')
  }
  if (event.altKey) {
    modifiers.push('alt')
  }
  if (event.metaKey) {
    modifiers.push('meta')
  }
  return modifiers
}

/**
 * Turns user input on the canvas and hidden textarea into page input. The textarea is the only
 * focusable thing, so the OS IME composes in Orca's own window and only the finished text crosses
 * to the page — which is what keeps agent input and the user's IME from ever sharing a focus.
 */
export function bindOffscreenPageInputSurface(
  canvas: HTMLCanvasElement,
  ime: HTMLTextAreaElement,
  sink: OffscreenPageInputSink
): () => void {
  let composing = false
  const cleanups: (() => void)[] = []
  const on = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
  ) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listener is typed by the same event-map key passed to addEventListener.
    const handler = listener as EventListener
    target.addEventListener(type, handler, options)
    cleanups.push(() => target.removeEventListener(type, handler, options))
  }

  const placeIme = () => {
    void sink.readCaret().then((caret) => {
      if (caret) {
        ime.style.left = `${caret.x}px`
        ime.style.top = `${caret.y}px`
        ime.style.height = `${caret.height}px`
      }
    })
  }
  const mouse = (type: 'mouseDown' | 'mouseUp' | 'mouseMove', event: MouseEvent) => {
    sink.input({
      kind: 'mouse',
      type,
      x: event.offsetX,
      y: event.offsetY,
      button: BUTTONS[event.button] ?? 'left',
      clickCount: type === 'mouseMove' ? 0 : Math.max(1, Math.min(3, event.detail)),
      modifiers: modifiersOf(event)
    })
  }

  on(canvas, 'mousedown', (event) => {
    // Why: keep the browser from moving focus to the canvas; the textarea owns keyboard focus.
    event.preventDefault()
    ime.focus({ preventScroll: true })
    sink.focusPage()
    mouse('mouseDown', event)
    placeIme()
  })
  on(canvas, 'mouseup', (event) => mouse('mouseUp', event))
  on(canvas, 'mousemove', (event) => mouse('mouseMove', event))
  on(canvas, 'mouseleave', (event) =>
    sink.input({
      kind: 'mouse',
      type: 'mouseLeave',
      x: event.offsetX,
      y: event.offsetY,
      button: 'left',
      clickCount: 0,
      modifiers: []
    })
  )
  on(canvas, 'contextmenu', (event) => event.preventDefault())
  let lastWheelZoomAt = Number.NEGATIVE_INFINITY
  on(
    canvas,
    'wheel',
    (event) => {
      event.preventDefault()
      const zoom = wheelZoomDirection(event)
      if (zoom) {
        // Why throttle: a trackpad pinch arrives as a burst of ctrl+wheel events.
        const now = performance.now()
        if (now - lastWheelZoomAt >= WHEEL_ZOOM_INTERVAL_MS) {
          lastWheelZoomAt = now
          sink.zoom(zoom)
        }
        return
      }
      sink.input({
        kind: 'wheel',
        x: event.offsetX,
        y: event.offsetY,
        deltaX: -event.deltaX,
        deltaY: -event.deltaY,
        modifiers: modifiersOf(event)
      })
    },
    { passive: false }
  )

  on(ime, 'compositionstart', () => {
    composing = true
    placeIme()
  })
  on(ime, 'compositionupdate', (event) => {
    const text = event.data ?? ''
    sink.input({ kind: 'compose', text, selectionStart: text.length, selectionEnd: text.length })
  })
  on(ime, 'compositionend', (event) => {
    composing = false
    const text = event.data ?? ''
    sink.input(text ? { kind: 'commit', text } : { kind: 'cancelComposition' })
    ime.value = ''
    placeIme()
  })
  // Why: IMEs and dictation can insert text without a composition; forward it as committed text.
  on(ime, 'input', () => {
    if (!composing && ime.value) {
      sink.input({ kind: 'commit', text: ime.value })
      ime.value = ''
    }
  })
  for (const action of ['copy', 'cut', 'paste'] as const) {
    on(ime, action, (event) => {
      event.preventDefault()
      sink.edit(action)
    })
  }
  // Why on window, bubbling: listeners registered here run after Orca's own shortcut handlers, so
  // a key Orca claimed (and prevented) is never also delivered to the page.
  on(window, 'keydown', (event) => {
    if (event.composedPath()[0] !== ime || event.defaultPrevented) {
      return
    }
    if (composing || event.isComposing || event.keyCode === 229) {
      return
    }
    forwardKey(event, sink)
    // Why: the page owns the key's text and its edit chords; the empty textarea must not act too,
    // and on macOS a handled key keeps the Edit menu from firing a second time.
    event.preventDefault()
  })
  // Why: the Edit menu asks whoever owns focus to copy, select all or paste. The textarea never
  // holds a selection, so native handling would do nothing; the page's own commands do.
  let imeFocused = false
  on(ime, 'focus', () => {
    imeFocused = true
    sink.setKeyboardFocus(true)
  })
  on(ime, 'blur', () => {
    imeFocused = false
    sink.setKeyboardFocus(false)
  })
  const focused = () => imeFocused && ime.isConnected
  const onMenuSelection = (event: Event) => {
    if (focused() && event instanceof CustomEvent) {
      event.preventDefault()
      sink.edit(event.detail === 'select-all' ? 'selectAll' : 'copy')
    }
  }
  const onMenuPaste = (event: Event) => {
    if (focused()) {
      event.preventDefault()
      sink.edit('paste')
    }
  }
  window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onMenuSelection)
  window.addEventListener(APP_MENU_PASTE_EVENT, onMenuPaste)
  cleanups.push(() => {
    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onMenuSelection)
    window.removeEventListener(APP_MENU_PASTE_EVENT, onMenuPaste)
  })
  on(ime, 'keyup', (event) => {
    if (!composing && !event.isComposing) {
      sink.input({ kind: 'key', type: 'keyUp', keyCode: event.key, modifiers: modifiersOf(event) })
    }
  })

  return () => {
    for (const cleanup of cleanups) {
      cleanup()
    }
    if (imeFocused) {
      sink.setKeyboardFocus(false)
    }
  }
}

const WHEEL_ZOOM_INTERVAL_MS = 100

function wheelZoomDirection(event: WheelEvent): 'in' | 'out' | null {
  const zoomModifier = event.ctrlKey || (navigator.userAgent.includes('Mac') && event.metaKey)
  if (!zoomModifier || event.altKey || event.shiftKey || event.deltaY === 0) {
    return null
  }
  return event.deltaY < 0 ? 'in' : 'out'
}

const EDIT_CHORDS: Record<string, EditAction> = {
  a: 'selectAll',
  c: 'copy',
  x: 'cut',
  v: 'paste',
  z: 'undo'
}

function forwardKey(event: KeyboardEvent, sink: OffscreenPageInputSink): void {
  const primary = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
  const chord = primary && !event.altKey ? EDIT_CHORDS[event.key.toLowerCase()] : undefined
  if (chord) {
    sink.edit(chord === 'undo' && event.shiftKey ? 'redo' : chord)
    return
  }
  const modifiers = modifiersOf(event)
  sink.input({ kind: 'key', type: 'keyDown', keyCode: event.key, modifiers })
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    sink.input({ kind: 'key', type: 'char', keyCode: event.key, modifiers })
  }
}
