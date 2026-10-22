/** A guest frame asks main whether its page is offscreen; main answers with the channels below. */
export const OFFSCREEN_PAGE_GUEST_KIND_CHANNEL = 'offscreen-page:is-offscreen'

/** Channels an offscreen page's frames use on the page's own ipc. */
export const OFFSCREEN_PAGE_GUEST_CHANNELS = {
  /** Frames report their hover tooltip. */
  tooltip: 'offscreen-page:tooltip',
  /** Main asks for the open datalist's rows; the focused frame answers on datalistItems. */
  datalistQuery: 'offscreen-page:datalist-query',
  datalistItems: 'offscreen-page:datalist-items',
  /** Main arms every frame's pinch guard before a ctrl+wheel; each frame acks on wheelZoomArmed. */
  wheelZoomArm: 'offscreen-page:wheel-zoom-arm',
  wheelZoomArmed: 'offscreen-page:wheel-zoom-armed',
  /** A frame reports a ctrl+wheel its page left unhandled, with the DOM deltaY. */
  wheelZoomUnhandled: 'offscreen-page:wheel-zoom-unhandled'
} as const

export type OffscreenPageGuestChannels = {
  [K in keyof typeof OFFSCREEN_PAGE_GUEST_CHANNELS]: string
}

export type OffscreenPageDatalistItem = { value: string; label: string }
