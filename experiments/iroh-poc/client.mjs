/**
 * iroh PoC client — dial by EndpointId only, measure path / latency / throughput.
 * Usage: node client.mjs <endpointId> [--quick]
 */
import { Endpoint, EndpointId, EndpointAddr } from '@number0/iroh'

const ALPN = Array.from(Buffer.from('orca-iroh-poc/1'))
const PINGS = 20
const THROUGHPUT_BYTES = 10 * 1024 * 1024
const HOLD_MS = 60_000
const CHUNK = 64 * 1024

function toBytes(s) {
  return Array.from(Buffer.from(s, 'utf8'))
}

function fromBytes(arr) {
  return Buffer.from(arr).toString('utf8')
}

function pathType(paths) {
  const selected = paths.find((p) => p.isSelected) ?? paths[0]
  if (!selected) {
    return { label: 'unknown', detail: 'no paths' }
  }
  const kinds = []
  if (selected.isIp) {
    kinds.push('direct')
  }
  if (selected.isRelay) {
    kinds.push('relayed')
  }
  return {
    label: kinds.join('+') || 'unknown',
    detail: `id=${selected.id} remote=${selected.remoteAddr} rttMs=${selected.rttMs} selected=${selected.isSelected}`,
    selected
  }
}

function summarizePaths(paths) {
  return paths
    .map(
      (p) =>
        `  ${p.isSelected ? '*' : ' '} ${p.isIp ? 'IP' : ''}${p.isRelay ? 'RELAY' : ''} ` +
        `remote=${p.remoteAddr} rttMs=${p.rttMs}`
    )
    .join('\n')
}

async function roundTrip(conn, payload) {
  const bi = await conn.openBi()
  const t0 = performance.now()
  await bi.send.writeAll(toBytes(payload))
  await bi.send.finish()
  const resp = await bi.recv.readToEnd(1024)
  const ms = performance.now() - t0
  return { ms, resp: fromBytes(resp) }
}

async function readExact(recv, n) {
  let got = 0
  while (got < n) {
    const chunk = await recv.read(Math.min(CHUNK, n - got))
    if (!chunk || chunk.length === 0) {
      break
    }
    got += chunk.length
  }
  return got
}

async function throughput(conn, n) {
  const bi = await conn.openBi()
  const t0 = performance.now()
  await bi.send.writeAll(toBytes(`THROUGHPUT ${n}`))
  await bi.send.finish()
  const got = await readExact(bi.recv, n)
  const ms = performance.now() - t0
  return { ms, got, mbps: (got * 8) / (ms / 1000) / 1e6 }
}

async function main() {
  const quick = process.argv.includes('--quick')
  const idStr = process.argv.slice(2).find((a) => a !== '--quick')
  if (!idStr) {
    console.error('Usage: node client.mjs <endpointId> [--quick]')
    process.exit(2)
  }

  let remoteId
  try {
    remoteId = EndpointId.fromString(idStr)
  } catch (err) {
    console.error('Invalid EndpointId:', err?.message ?? err)
    process.exit(2)
  }

  console.log('Dialing by EndpointId only (no IP/port)…')
  console.log('  EndpointId:', remoteId.toString())

  const ep = await Endpoint.bind()
  await ep.online()

  // Public-key dial: addr carries only the id; n0 discovery finds path.
  const addr = new EndpointAddr(remoteId)
  let conn
  let established = false
  try {
    conn = await ep.connect(addr, ALPN)
    established = true
  } catch (err) {
    console.log('')
    console.log('=== REPORT ===')
    console.log('connection established: no')
    console.log('error:', err?.message ?? err)
    await ep.close()
    process.exit(1)
  }

  console.log('connection established: yes')
  console.log('remote id:', conn.remoteId().toString())

  // (b) path type — may improve after a few RTTs (hole punch).
  let typeInfo = pathType(conn.paths())
  console.log('connection type (initial):', typeInfo.label)
  console.log(typeInfo.detail)
  if (conn.paths().length) {
    console.log(`paths:\n${summarizePaths(conn.paths())}`)
  }

  // Warm one echo, then measure.
  const warm = await roundTrip(conn, 'ECHO warm')
  if (warm.resp !== 'warm') {
    console.warn('unexpected echo:', warm.resp)
  }

  // (c) latency over 20 pings
  const samples = []
  for (let i = 0; i < PINGS; i++) {
    const { ms, resp } = await roundTrip(conn, 'PING')
    if (resp !== 'PONG') {
      console.warn(`ping ${i}: unexpected ${resp}`)
    }
    samples.push(ms)
  }
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length

  // Re-check path after traffic (hole punch may have completed).
  typeInfo = pathType(conn.paths())
  console.log('connection type (after pings):', typeInfo.label)
  console.log(typeInfo.detail)

  // (d) throughput 10 MB
  console.log(`throughput: requesting ${THROUGHPUT_BYTES} bytes…`)
  const thr = await throughput(conn, THROUGHPUT_BYTES)

  console.log('')
  console.log('=== REPORT ===')
  console.log('connection established:', established ? 'yes' : 'no')
  console.log('connection type:', typeInfo.label, `(${typeInfo.detail})`)
  console.log(
    `latency (${PINGS} pings): min=${min.toFixed(2)} ms  avg=${avg.toFixed(2)} ms  max=${max.toFixed(2)} ms`
  )
  console.log(
    `throughput: ${thr.got}/${THROUGHPUT_BYTES} bytes in ${thr.ms.toFixed(1)} ms  (~${thr.mbps.toFixed(2)} Mbit/s)`
  )
  const rtt = conn.rtt()
  if (rtt != null) {
    console.log(`quic rtt (transport): ${rtt} ms`)
  }

  // (e) hold connection, watch path changes
  if (quick) {
    console.log('hold: skipped (--quick)')
  } else {
    console.log(`hold: watching paths for ${HOLD_MS / 1000}s…`)
    const handle = conn.watchPaths((paths) => {
      const t = pathType(paths)
      console.log(`[path change] type=${t.label} ${t.detail}`)
      console.log(summarizePaths(paths))
    })
    const events = conn.watchPathEvents((ev) => {
      console.log(`[path event] kind=${ev.kind} id=${ev.id ?? '-'} remote=${ev.remoteAddr ?? '-'}`)
    })
    await new Promise((r) => setTimeout(r, HOLD_MS))
    await handle.stop()
    await events.stop()
    typeInfo = pathType(conn.paths())
    console.log('connection type (final):', typeInfo.label)
  }

  conn.close(0n, toBytes('done'))
  await ep.close()
  console.log('done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
