import { CopyX } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { TabStripSelection } from './tab-strip-selection'

/** Shown only when the right-clicked tab is part of a multi-selection. */
export function CloseSelectedTabsMenuItem({
  selection
}: {
  selection: TabStripSelection | undefined
}): React.JSX.Element | null {
  if (!selection?.isSelected) {
    return null
  }
  return (
    <DropdownMenuItem onSelect={selection.onCloseSelected}>
      <CopyX className="size-3.5" />
      {translate('components.tab.bar.closeSelectedTabs', 'Close Selected Tabs')}
    </DropdownMenuItem>
  )
}
