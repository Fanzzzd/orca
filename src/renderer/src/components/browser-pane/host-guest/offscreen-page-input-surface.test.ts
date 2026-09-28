// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OffscreenPageUserInput } from '../../../../../shared/offscreen-page-protocol'
import { bindOffscreenPageInputSurface } from './offscreen-page-input-surface'

function setup() {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  const canvas = document.createElement('canvas')
  const ime = document.createElement('textarea')
  root.append(canvas, ime)
  document.body.append(host)
  const inputs: OffscreenPageUserInput[] = []
  const sink = {
    input: vi.fn((input: OffscreenPageUserInput) => void inputs.push(input)),
    edit: vi.fn<(action: string) => void>(),
    focusPage: vi.fn<() => void>(),
    readCaret: vi.fn(() => Promise.resolve({ x: 40, y: 12, height: 18 }))
  }
  const unbind = bindOffscreenPageInputSurface(canvas, ime, sink)
  return { canvas, ime, sink, inputs, unbind }
}

// Why: happy-dom drops CompositionEventInit.data; Chromium keeps it.
function composition(type: string, data = ''): Event {
  return Object.defineProperty(new Event(type), 'data', { value: data })
}

function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('bindOffscreenPageInputSurface', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('focuses the hidden textarea and the page on mousedown, then places the IME box at the caret', async () => {
    const { canvas, ime, sink, inputs } = setup()
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1
    })
    canvas.dispatchEvent(down)

    expect(down.defaultPrevented).toBe(true)
    expect(sink.focusPage).toHaveBeenCalledOnce()
    expect(inputs[0]).toMatchObject({
      kind: 'mouse',
      type: 'mouseDown',
      button: 'left',
      clickCount: 1
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(ime.style.left).toBe('40px')
    expect(ime.style.top).toBe('12px')
  })

  it('forwards composition as compose updates and a single commit', () => {
    const { ime, inputs } = setup()
    ime.dispatchEvent(composition('compositionstart'))
    ime.dispatchEvent(composition('compositionupdate', 'ni'))
    // Keys typed mid-composition belong to the IME, not the page.
    keydown(ime, { key: 'h', keyCode: 229, isComposing: true })
    ime.dispatchEvent(composition('compositionupdate', 'nih'))
    ime.value = '你好'
    ime.dispatchEvent(new Event('input'))
    ime.dispatchEvent(composition('compositionend', '你好'))

    expect(inputs).toEqual([
      { kind: 'compose', text: 'ni', selectionStart: 2, selectionEnd: 2 },
      { kind: 'compose', text: 'nih', selectionStart: 3, selectionEnd: 3 },
      { kind: 'commit', text: '你好' }
    ])
    expect(ime.value).toBe('')
  })

  it('cancels the page composition when the IME ends with no text', () => {
    const { ime, inputs } = setup()
    ime.dispatchEvent(composition('compositionstart'))
    ime.dispatchEvent(composition('compositionupdate', 'a'))
    ime.dispatchEvent(composition('compositionend', ''))
    expect(inputs.at(-1)).toEqual({ kind: 'cancelComposition' })
  })

  it('forwards a printable key as keyDown plus char and keeps it out of the textarea', () => {
    const { ime, inputs } = setup()
    const event = keydown(ime, { key: 'a', cancelable: true })
    expect(inputs).toEqual([
      { kind: 'key', type: 'keyDown', keyCode: 'a', modifiers: [] },
      { kind: 'key', type: 'char', keyCode: 'a', modifiers: [] }
    ])
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a key alone when an Orca shortcut already claimed it', () => {
    const { ime, inputs } = setup()
    const claim = (event: Event) => event.preventDefault()
    ime.getRootNode().addEventListener('keydown', claim)
    keydown(ime, { key: 'k', metaKey: true, cancelable: true })
    ime.getRootNode().removeEventListener('keydown', claim)
    expect(inputs).toEqual([])
  })

  it('ignores keys aimed at anything but the hidden textarea', () => {
    const { inputs } = setup()
    const terminal = document.createElement('textarea')
    document.body.append(terminal)
    keydown(terminal, { key: 'a', cancelable: true })
    expect(inputs).toEqual([])
  })

  it('turns clipboard events and select-all into page edit commands', () => {
    const { ime, sink, inputs } = setup()
    const paste = new Event('paste', { cancelable: true })
    ime.dispatchEvent(paste)
    const isMac = navigator.userAgent.includes('Mac')
    keydown(ime, { key: 'a', metaKey: isMac, ctrlKey: !isMac, cancelable: true })

    expect(paste.defaultPrevented).toBe(true)
    expect(sink.edit.mock.calls).toEqual([['paste'], ['selectAll']])
    expect(inputs).toEqual([])
  })

  it('inverts wheel deltas into page scroll deltas', () => {
    const { canvas, inputs } = setup()
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }))
    expect(inputs[0]).toMatchObject({ kind: 'wheel', deltaX: -0, deltaY: -120 })
  })

  it('stops forwarding after unbind', () => {
    const { ime, canvas, inputs, unbind } = setup()
    unbind()
    keydown(ime, { key: 'a' })
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(inputs).toEqual([])
  })
})
