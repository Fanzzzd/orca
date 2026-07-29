// Accept side of the iroh transport: drain incoming connections, apply the
// capacity cap, and hand each accepted bi-stream to the connection handler.
import type { BiStream, Endpoint, Incoming } from '@number0/iroh'
import { connectionPathKind, remoteIdPrefix } from './iroh-connection-log'
import { IrohFramedSocket } from './iroh-framed-socket'

const ACCEPT_RETRY_DELAY_MS = 1_000

export async function runIrohAcceptLoop(args: {
  endpoint: Endpoint
  isStopped: () => boolean
  atCapacity: () => boolean
  onConnection: (socket: IrohFramedSocket, bi: BiStream) => void
}): Promise<void> {
  while (!args.isStopped()) {
    let incoming: Incoming | null
    try {
      incoming = await args.endpoint.acceptNext()
    } catch (error) {
      if (args.isStopped()) {
        break
      }
      // Why: a silently dead accept loop leaves QRs advertising an endpoint
      // that accepts nothing — log and retry instead of giving up.
      console.warn(
        `[iroh-transport] acceptNext failed, retrying: ${error instanceof Error ? error.message : String(error)}`
      )
      await new Promise((resolve) => setTimeout(resolve, ACCEPT_RETRY_DELAY_MS).unref?.())
      continue
    }
    if (!incoming || args.isStopped()) {
      break
    }
    void acceptConnection(incoming, args)
  }
}

async function acceptConnection(
  incoming: Incoming,
  args: {
    atCapacity: () => boolean
    onConnection: (socket: IrohFramedSocket, bi: BiStream) => void
  }
): Promise<void> {
  try {
    if (args.atCapacity()) {
      try {
        const overflow = await (await incoming.accept()).connect()
        overflow.close(0n, [])
      } catch {
        // Drop over-capacity peers without affecting the accept loop.
      }
      return
    }
    const connection = await (await incoming.accept()).connect()
    const remotePrefix = remoteIdPrefix(connection)
    const kind = connectionPathKind(connection)
    console.info(`[iroh-transport] connection accepted remote=${remotePrefix} kind=${kind}`)
    // Why: dialing side (phone) opens the single long-lived bi-stream.
    const bi = await connection.acceptBi()
    args.onConnection(new IrohFramedSocket(bi, connection), bi)
  } catch (error) {
    console.warn(
      `[iroh-transport] accept failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
