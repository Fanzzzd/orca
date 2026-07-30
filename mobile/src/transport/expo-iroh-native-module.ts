// Lazy access to the iroh native module.
// Why: a top-level import throws at bundle load on Expo Go / web / any build
// without the pod, which would take the whole transport layer down with it.

export type ExpoIrohApi = typeof import('@orca/expo-iroh')

export function loadExpoIroh(): ExpoIrohApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@orca/expo-iroh') as ExpoIrohApi
}

export function expoIrohModuleLoads(): boolean {
  try {
    loadExpoIroh()
    return true
  } catch {
    return false
  }
}
