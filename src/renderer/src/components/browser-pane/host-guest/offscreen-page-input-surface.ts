import type { OffscreenPageUserInput } from '../../../../../shared/offscreen-page-protocol'

type Modifier = 'shift' | 'control' | 'alt' | 'meta'
type EditAction = 'copy' | 'cut' | 'paste' | 'selectAll' | 'undo' | 'redo'

export type OffscreenPageInputSink = {
  input(input: OffscreenPageUserInput): void
  edit(action: EditAction): void
  focusPage(): void
  /** Re-reads the page caret; resolves to element-relative CSS px or null. */
  readCaret(): Promise<{ x: number; y: number; height: number } | null>
}

const BUTTONS = ['left', 'middle', 'right'] as const

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
  on(
    canvas,
    'wheel',
    (event) => {
      event.preventDefault()
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
    // Why: the page owns the key's text; letting it through would leave it in the textarea too.
    if (!isEditChord(event)) {
      event.preventDefault()
    }
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
  }
}

function isEditChord(event: KeyboardEvent): boolean {
  const primary = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
  return primary && ['c', 'x', 'v'].includes(event.key.toLowerCase())
}

function forwardKey(event: KeyboardEvent, sink: OffscreenPageInputSink): void {
  const primary = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
  if (primary && ['a', 'z'].includes(event.key.toLowerCase())) {
    sink.edit(event.key.toLowerCase() === 'a' ? 'selectAll' : event.shiftKey ? 'redo' : 'undo')
    return
  }
  if (isEditChord(event)) {
    // Copy/cut/paste arrive as clipboard events on the textarea.
    return
  }
  const modifiers = modifiersOf(event)
  sink.input({ kind: 'key', type: 'keyDown', keyCode: event.key, modifiers })
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    sink.input({ kind: 'key', type: 'char', keyCode: event.key, modifiers })
  }
}
