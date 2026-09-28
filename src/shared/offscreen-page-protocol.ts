import { z } from 'zod'

// Why a closed schema: the renderer is the only sender, but it is still a separate process — main
// validates every event before it reaches sendInputEvent or the page's debugger.

const modifiers = z.array(z.enum(['shift', 'control', 'alt', 'meta'])).max(4)
const coordinate = z.number().finite()

export const OffscreenPageUserInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    type: z.enum(['mouseDown', 'mouseUp', 'mouseMove', 'mouseEnter', 'mouseLeave']),
    x: coordinate,
    y: coordinate,
    button: z.enum(['left', 'middle', 'right']).default('left'),
    clickCount: z.number().int().min(0).max(3).default(1),
    modifiers: modifiers.default([])
  }),
  z.object({
    kind: z.literal('wheel'),
    x: coordinate,
    y: coordinate,
    deltaX: coordinate,
    deltaY: coordinate,
    modifiers: modifiers.default([])
  }),
  z.object({
    kind: z.literal('key'),
    type: z.enum(['keyDown', 'keyUp', 'char']),
    keyCode: z.string().min(1).max(32),
    modifiers: modifiers.default([])
  }),
  // IME composition in progress: shown underlined in the page, not yet committed.
  z.object({
    kind: z.literal('compose'),
    text: z.string().max(256),
    selectionStart: z.number().int().min(0),
    selectionEnd: z.number().int().min(0)
  }),
  z.object({ kind: z.literal('commit'), text: z.string().max(64 * 1024) }),
  z.object({ kind: z.literal('cancelComposition') })
])

export type OffscreenPageUserInput = z.infer<typeof OffscreenPageUserInputSchema>

export const OffscreenPageViewportSchema = z.object({
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  visible: z.boolean()
})

export type OffscreenPageViewport = z.infer<typeof OffscreenPageViewportSchema>

/** Page-space rect of the text caret, used to park the hidden IME textarea under it. */
export type OffscreenPageCaret = { x: number; y: number; height: number }

/** Snapshot that backs the renderer element's synchronous webview-style getters. */
export type OffscreenPageGuestState = {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  zoomLevel: number
}

export type OffscreenPageGuestEvent = {
  type:
    | 'dom-ready'
    | 'did-start-loading'
    | 'did-stop-loading'
    | 'did-start-navigation'
    | 'did-redirect-navigation'
    | 'did-navigate'
    | 'did-navigate-in-page'
    | 'load-commit'
    | 'page-title-updated'
    | 'page-favicon-updated'
    | 'did-fail-load'
    | 'console-message'
    | 'found-in-page'
    | 'render-process-gone'
  detail: Record<string, unknown>
  state: OffscreenPageGuestState
}

/** Commands the renderer element issues on behalf of webview-style method calls. */
export const OffscreenPageCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('loadURL'), url: z.string().max(32 * 1024) }),
  z.object({ kind: z.literal('goBack') }),
  z.object({ kind: z.literal('goForward') }),
  z.object({ kind: z.literal('reload') }),
  z.object({ kind: z.literal('reloadIgnoringCache') }),
  z.object({ kind: z.literal('stop') }),
  z.object({ kind: z.literal('setZoomLevel'), level: z.number().finite().min(-10).max(10) }),
  z.object({
    kind: z.literal('findInPage'),
    text: z.string().min(1).max(1024),
    forward: z.boolean().optional(),
    findNext: z.boolean().optional(),
    matchCase: z.boolean().optional()
  }),
  // Why: on macOS Edit-menu roles act on the focused window, which is Orca's, never the offscreen page.
  z.object({
    kind: z.literal('edit'),
    action: z.enum(['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo'])
  }),
  z.object({
    kind: z.literal('stopFindInPage'),
    action: z.enum(['clearSelection', 'keepSelection', 'activateSelection'])
  })
])

export type OffscreenPageCommand = z.infer<typeof OffscreenPageCommandSchema>
