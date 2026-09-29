import { useEffect, useState } from 'react'
import { webviewRegistry } from '../host-guest/webview-registry'

type ExtensionTab = { partition: string; tabId: number }

declare module 'react' {
  namespace JSX {
    // oxlint-disable-next-line typescript/consistent-type-definitions -- augmenting React's JSX types needs interface merging.
    interface IntrinsicElements {
      /** electron-chrome-extensions' toolbar buttons, defined by the main window's preload. */
      'browser-action-list': {
        partition: string
        tab: number
        alignment: string
        className?: string
      }
    }
  }
}

/** The page's extension buttons; each opens its extension's popup against this tab. */
export function BrowserExtensionActions({
  browserPageId,
  loading
}: {
  browserPageId: string
  /** Why a dependency: each load is when a new or replaced guest has become readable. */
  loading: boolean
}): React.JSX.Element | null {
  const [tab, setTab] = useState<ExtensionTab | null>(null)

  useEffect(() => {
    const webview = webviewRegistry.get(browserPageId)
    if (!webview) {
      return
    }
    const read = (): void => {
      try {
        setTab({ partition: webview.partition, tabId: webview.getWebContentsId() })
      } catch {
        // Not attached yet; dom-ready reads it again.
      }
    }
    read()
    webview.addEventListener('dom-ready', read)
    return () => {
      webview.removeEventListener('dom-ready', read)
    }
  }, [browserPageId, loading])

  if (!tab) {
    return null
  }
  return (
    <browser-action-list
      className="flex h-7 items-center"
      partition={tab.partition}
      tab={tab.tabId}
      alignment="bottom right"
    />
  )
}
