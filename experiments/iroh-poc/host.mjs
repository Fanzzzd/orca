/**
 * iroh PoC host — bind, print EndpointId, echo + throughput on custom ALPN.
 * Usage: node host.mjs
 */
import { Endpoint } from '@number0/iroh'

const ALPN = Array.from(Buffer.from('orca-iroh-poc/1'))
const CHUNK = 64 * 1024

function toBytes(s) {
  return Array.from(Buffer.from(s, 'utf8'))
}

function fromBytes(arr) {
  return Buffer.from(arr).toString('utf8')
}

async function handleBi(conn) {
  const bi = await conn.acceptBi()
  const req = await bi.recv.readToEnd(256)
  const text = fromBytes(req).trim()

  if (text === 'PING') {
    await bi.send.writeAll(toBytes('PONG'))
    await bi.send.finish()
    return
  }

  if (text.startsWith('ECHO ')) {
    await bi.send.writeAll(toBytes(text.slice(5)))
    await bi.send.finish()
    return
  }

  if (text.startsWith('THROUGHPUT ')) {
    const n = Number(text.slice('THROUGHPUT '.length))
    if (!Number.isFinite(n) || n < 0 || n > 256 * 1024 * 1024) {
      await bi.send.writeAll(toBytes('ERR bad size'))
      await bi.send.finish()
      return
    }
    // Stream n zero-bytes in chunks (avoid huge Array allocations).
    let left = n
    const zero = Buffer.alloc(CHUNK)
    while (left > 0) {
      const take = Math.min(CHUNK, left)
      await bi.send.writeAll(Array.from(zero.subarray(0, take)))
      left -= take
    }
    await bi.send.finish()
    console.log(`[host] throughput served ${n} bytes`)
    return
  }

  await bi.send.writeAll(toBytes(`ERR unknown: ${text}`))
  await bi.send.finish()
}

async function main() {
  const ep = await Endpoint.bind({ alpns: [ALPN] })
  await ep.online()

  const id = ep.id().toString()
  console.log('')
  console.log('========================================')
  console.log('  EndpointId:', id)
  console.log('========================================')
  console.log('')
  console.log('Client (other shell / machine):')
  console.log(`  node client.mjs ${id}`)
  console.log('')
  console.log('Bound sockets:', ep.boundSockets().join(', ') || '(none yet)')
  const addr = ep.addr()
  console.log('Relay URL:', addr.relayUrl() ?? '(none)')
  console.log('Direct addrs:', addr.directAddresses().join(', ') || '(none yet)')
  console.log('Waiting for connections on ALPN orca-iroh-poc/1 … (Ctrl+C to quit)')
  console.log('')

  // Accept loop: one connection, many bi streams (ping / echo / throughput).
  for (;;) {
    const incoming = await ep.acceptNext()
    if (!incoming) {
      break
    }
    const remote = await incoming.remoteAddr()
    console.log(`[host] incoming kind=${remote.kind} addr=${remote.addr ?? '?'}`)
    const conn = await (await incoming.accept()).connect()
    console.log(`[host] connected remote=${conn.remoteId().toString()}`)
    ;(async () => {
      try {
        for (;;) {
          await handleBi(conn)
        }
      } catch (err) {
        console.log(`[host] connection closed: ${err?.message ?? err}`)
      }
    })()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
