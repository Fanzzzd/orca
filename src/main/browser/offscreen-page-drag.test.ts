import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { sendDebuggerCommand } = vi.hoisted(() => ({
  sendDebuggerCommand: vi.fn((_debugger: unknown, _method: string, _params?: unknown) =>
    Promise.resolve({})
  )
}))
vi.mock('./browser-screencast-debugger-command', () => ({ sendDebuggerCommand }))

import { createOffscreenPageDragBridge } from './offscreen-page-drag'

function fakePage() {
  const contents = Object.assign(new EventEmitter(), {
    debugger: new EventEmitter(),
    isDestroyed: () => false
  })
  const lease = { release: vi.fn() }
  const acquire = vi.fn(() => lease)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the bridge touches.
  const bridge = createOffscreenPageDragBridge(contents as never, acquire as never)
  const dragEvents = () =>
    sendDebuggerCommand.mock.calls
      .filter(([, method]) => method === 'Input.dispatchDragEvent')
      .map(([, , params]) => params)
  return { contents, lease, acquire, bridge, dragEvents }
}

describe('createOffscreenPageDragBridge', () => {
  it('arms drag interception on the page debugger', () => {
    sendDebuggerCommand.mockClear()
    const { acquire } = fakePage()
    expect(acquire).toHaveBeenCalledOnce()
    expect(sendDebuggerCommand).toHaveBeenCalledWith(expect.anything(), 'Input.setInterceptDrags', {
      enabled: true
    })
  })

  it('replays pointer input after an intercepted drag as enter, over and drop', () => {
    sendDebuggerCommand.mockClear()
    const { contents, dragEvents } = fakePage()
    const data = { items: [{ mimeType: 'text/plain', data: 'x' }], dragOperationsMask: 1 }
    contents.emit('input-event', {}, { type: 'mouseMove', x: 1, y: 1 })
    expect(dragEvents()).toEqual([])

    contents.debugger.emit('message', {}, 'Input.dragIntercepted', { data })
    contents.emit('input-event', {}, { type: 'mouseMove', x: 10, y: 20 })
    contents.emit('input-event', {}, { type: 'mouseMove', x: 30, y: 40 })
    contents.emit('input-event', {}, { type: 'mouseUp', x: 30, y: 40 })
    contents.emit('input-event', {}, { type: 'mouseMove', x: 50, y: 60 })

    expect(dragEvents()).toEqual([
      { type: 'dragEnter', x: 10, y: 20, data },
      { type: 'dragOver', x: 10, y: 20, data },
      { type: 'dragOver', x: 30, y: 40, data },
      { type: 'drop', x: 30, y: 40, data }
    ])
  })

  it('cancels the drag when the pointer leaves the page or Escape is pressed', () => {
    sendDebuggerCommand.mockClear()
    const { contents, dragEvents } = fakePage()
    contents.debugger.emit('message', {}, 'Input.dragIntercepted', { data: {} })
    contents.emit('input-event', {}, { type: 'mouseLeave', x: 5, y: 5 })
    contents.debugger.emit('message', {}, 'Input.dragIntercepted', { data: {} })
    contents.emit('input-event', {}, { type: 'rawKeyDown', key: 'Escape' })
    expect(dragEvents().map((event) => Reflect.get(Object(event), 'type'))).toEqual([
      'dragCancel',
      'dragCancel'
    ])
  })

  it('drops OS files as one enter, over, drop sequence at the drop point', async () => {
    sendDebuggerCommand.mockClear()
    const { bridge, dragEvents } = fakePage()
    await bridge.dropFiles({ x: 10.4, y: 20.6, files: ['/tmp/a.txt'] })
    const data = { items: [], files: ['/tmp/a.txt'], dragOperationsMask: 1 }
    expect(dragEvents()).toEqual([
      { type: 'dragEnter', x: 10, y: 21, data },
      { type: 'dragOver', x: 10, y: 21, data },
      { type: 'drop', x: 10, y: 21, data }
    ])
  })

  it('re-arms on the next input after the debugger detaches, and releases on dispose', () => {
    const { contents, lease, acquire, bridge } = fakePage()
    contents.debugger.emit('detach')
    expect(lease.release).toHaveBeenCalledOnce()
    contents.emit('input-event', {}, { type: 'mouseMove', x: 0, y: 0 })
    expect(acquire).toHaveBeenCalledTimes(2)
    bridge.dispose()
    expect(lease.release).toHaveBeenCalledTimes(2)
    expect(contents.listenerCount('input-event')).toBe(0)
  })
})
