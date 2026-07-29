import { Platform } from 'react-native'
import { hostHasIrohEndpointId, inferIrohPathMode } from './mobile-iroh-candidate-eval'

export { hostHasIrohEndpointId as hostHasIrohEndpoint, inferIrohPathMode }

// Why: native module is iOS-first; Android methods reject with iroh_android_not_implemented.
export function isIrohNativePlatform(): boolean {
  return Platform.OS === 'ios'
}

/**
 * Sync probe for the native module. Callers use it to fall back to the ws
 * dial BEFORE constructing an iroh socket — a deferred load failure would
 * otherwise surface as an endless iroh reconnect loop (Expo Go, dev client
 * without the pod).
 */
export function isIrohNativeModuleAvailable(): boolean {
  if (!isIrohNativePlatform()) {
    return false
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@orca/expo-iroh')
    return true
  } catch {
    return false
  }
}
