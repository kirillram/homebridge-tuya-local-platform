import dgram from 'dgram'
import crypto from 'crypto'
import os from 'os'
import { EventEmitter } from 'events'
import type { Logger } from 'homebridge'
import type { DiscoveredDevice } from '../types'

// MD5("yGAdlopoPVldABfn") — well-known Tuya UDP broadcast key (same as tuyapi / tinytuya)
const UDP_KEY = Buffer.from('6c1ec8e2bb9bb59ab50b0daf649b410a', 'hex')

const PREFIX_55AA = 0x000055aa
const SUFFIX_AA55 = 0x0000aa55
const PREFIX_6699 = 0x00006699
const SUFFIX_9966 = 0x00009966
const CMD_REQ_DEVINFO = 0x25 // tinytuya REQ_DEVINFO — solicit v3.5 devices on UDP/7000

interface LocalIPv4 {
  address: string
  broadcast: string
}

interface DiscoveryOptions {
  log: Logger
  ids?: string[]
  clear?: boolean
}

class TuyaDiscovery extends EventEmitter {
  discovered: Map<string, string> = new Map()
  limitedIds: string[] = []
  log!: Logger

  private _servers: Record<number, dgram.Socket | null> = {}
  private _running = false
  private _solicitTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    super()
  }

  start(props: DiscoveryOptions): this {
    this.log = props.log

    if (props.clear) {
      this.removeAllListeners()
      this.discovered.clear()
    }

    this.limitedIds.splice(0)
    if (Array.isArray(props.ids)) [].push.apply(this.limitedIds, props.ids)

    this._running = true
    this._start(6666)
    this._start(6667)
    this._start(7000)
    this._startSolicitation()

    return this
  }

  stop(): this {
    this._running = false
    this._stopSolicitation()
    this._stop(6666)
    this._stop(6667)
    this._stop(7000)

    return this
  }

  end(): this {
    this.stop()
    process.nextTick(() => {
      this.removeAllListeners()
      this.discovered.clear()
      this.log.info('Discovery ended.')
      this.emit('end')
    })

    return this
  }

  private _start(port: number): void {
    this._stop(port)

    const server = (this._servers[port] = dgram.createSocket({ type: 'udp4', reuseAddr: true }))
    server.on('error', this._onDgramError.bind(this, port))
    server.on('close', this._onDgramClose.bind(this, port))
    server.on('message', this._onDgramMessage.bind(this, port))

    server.bind(port, () => {
      try {
        server.setBroadcast(true)
      } catch (_ex) {
        /* ignore */
      }
      this.log.info(`Discovery - Discovery started on port ${port}.`)
      // Wait until UDP/7000 is actually bound; send() before that kills the process
      if (port === 7000 && this._running) this._solicit()
    })
  }

  private _stop(port: number): void {
    const server = this._servers[port]
    if (!server) return
    this._servers[port] = null
    server.removeAllListeners()
    try {
      server.close()
    } catch (_ex) {
      /* already closed / never bound */
    }
  }

  private _startSolicitation(): void {
    this._stopSolicitation()
    // Newer 3.5 devices may stay silent until solicited on UDP/7000
    this._solicitTimer = setInterval(() => this._solicit(), 5000)
  }

  private _stopSolicitation(): void {
    if (this._solicitTimer) {
      clearInterval(this._solicitTimer)
      this._solicitTimer = null
    }
  }

  private _solicit(): void {
    const server = this._servers[7000]
    if (!server || !this._running) return

    // Devices unicast their 3.5 discovery reply to this IP (tinytuya send_discovery_request)
    const ifaces = getLocalIPv4s()
    const targets: LocalIPv4[] = ifaces.length ? ifaces : [{ address: '255.255.255.255', broadcast: '255.255.255.255' }]

    for (const { address, broadcast } of targets) {
      try {
        const payload = Buffer.from(JSON.stringify({ from: 'app', ip: address }))
        const packet = packGcmDiscovery(CMD_REQ_DEVINFO, payload)
        server.send(packet, 0, packet.length, 7000, broadcast, (err) => {
          if (err) this.log.debug(`Discovery - Solicitation failed (${address} → ${broadcast}): ${err.message}`)
        })
        this.log.debug(`Discovery - soliciting 3.5 devices from ${address} → ${broadcast}:7000`)
      } catch (err) {
        this.log.debug(`Discovery - Solicitation failed (${address} → ${broadcast}): ${(err as Error).message}`)
      }
    }

    // Some stacks drop directed broadcasts; also send a limited broadcast with a LAN IP
    const lan =
      targets.find((iface) => iface.address.startsWith('192.168.')) ||
      targets.find((iface) => iface.address.startsWith('10.')) ||
      targets[0]
    if (lan && lan.broadcast !== '255.255.255.255') {
      try {
        const payload = Buffer.from(JSON.stringify({ from: 'app', ip: lan.address }))
        const packet = packGcmDiscovery(CMD_REQ_DEVINFO, payload)
        server.send(packet, 0, packet.length, 7000, '255.255.255.255', () => {
          /* ignore broadcast fallback errors */
        })
      } catch (_err) {
        /* already logged per-interface failures */
      }
    }
  }

  private _onDgramError(port: number, err: NodeJS.ErrnoException): void {
    this._stop(port)

    if (err && err.code === 'EADDRINUSE') {
      this.log.warn(`Discovery - Port ${port} is in use. Will retry in 15 seconds.`)

      setTimeout(() => {
        this._start(port)
      }, 15000)
    } else {
      this.log.error(`Discovery - Port ${port} failed:\n${err.stack}`)
    }
  }

  private _onDgramClose(port: number): void {
    this._stop(port)

    this.log.info(`Discovery - Port ${port} closed.${this._running ? ' Restarting...' : ''}`)
    if (this._running)
      setTimeout(() => {
        this._start(port)
      }, 1000)
  }

  private _onDgramMessage(port: number, msg: Buffer, info: dgram.RemoteInfo): void {
    const len = msg.length
    if (len < 16) {
      this.log.error(`Discovery - UDP from ${info.address}:${port}`, msg.toString('hex'))
      return
    }

    const prefix = msg.readUInt32BE(0)
    const suffix = msg.readUInt32BE(len - 4)

    let decryptedMsg: string | undefined

    if (prefix === PREFIX_6699 && suffix === SUFFIX_9966) {
      try {
        decryptedMsg = decryptGcmDiscovery(msg)
      } catch (_ex) {
        // Undecryptable GCM frame — ignore (may be for another listener)
        return
      }
    } else if (prefix === PREFIX_55AA && suffix === SUFFIX_AA55) {
      const size = msg.readUInt32BE(12)
      if (len - size < 8) {
        this.log.error(`Discovery - UDP from ${info.address}:${port} size ${len - size}`)
        return
      }

      const cleanMsg = msg.slice(len - size + 4, len - 8)

      if (port === 6667 || port === 7000) {
        try {
          const decipher = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, '')
          decryptedMsg = decipher.update(cleanMsg, undefined, 'utf8')
          decryptedMsg += decipher.final('utf8')
        } catch (_ex) {
          // Encrypted broadcast could not be decrypted — device may already
          // have been discovered on port 6666.  Silently ignore.
          return
        }
      } else {
        decryptedMsg = cleanMsg.toString('utf8')
      }
    } else {
      this.log.error(`Discovery - UDP from ${info.address}:${port}`, msg.toString('hex'))
      return
    }

    if (!decryptedMsg) return

    try {
      const result = JSON.parse(decryptedMsg) as Record<string, unknown>
      if (!result || result.from === 'app') return

      const gwId = typeof result.gwId === 'string' ? result.gwId : ''
      if (!gwId) {
        this.log.debug(`Discovery - ignoring UDP from ${info.address}:${port}:`, decryptedMsg)
        return
      }

      const reportedIp = typeof result.ip === 'string' ? result.ip.trim() : ''
      result.ip = reportedIp || info.address
      this._onDiscover(result as Record<string, unknown> & { gwId: string; ip: string })
    } catch (_ex) {
      this.log.debug(`Discovery - Failed to parse discovery response on port ${port}: ${decryptedMsg}`)
    }
  }

  private _onDiscover(data: Record<string, unknown> & { gwId: string; ip: string }): void {
    if (this.discovered.has(data.gwId)) return
    ;(data as unknown as DiscoveredDevice).id = data.gwId
    delete (data as Record<string, unknown>).gwId

    this.discovered.set((data as unknown as DiscoveredDevice).id, data.ip)

    this.emit('discover', data)

    if (
      this.limitedIds.length &&
      this.limitedIds.includes((data as unknown as DiscoveredDevice).id) &&
      this.limitedIds.length <= this.discovered.size &&
      this.limitedIds.every((id) => this.discovered.has(id))
    ) {
      process.nextTick(() => {
        this.end()
      })
    }
  }
}

/**
 * Pack a 6699 AES-GCM discovery/solicitation frame (tuyapi / tinytuya compatible).
 */
function packGcmDiscovery(cmd: number, plaintext: Buffer, seq = 0): Buffer {
  const header = Buffer.alloc(18)
  header.writeUInt32BE(PREFIX_6699, 0)
  header.writeUInt16BE(0, 4)
  header.writeUInt32BE(seq, 6)
  header.writeUInt32BE(cmd, 10)
  header.writeUInt32BE(plaintext.length + 28, 14) // IV(12) + tag(16)

  const aad = header.slice(4, 18)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-128-gcm', UDP_KEY, iv)
  cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([header, iv, encrypted, tag, Buffer.from([0x00, 0x00, 0x99, 0x66])])
}

/**
 * Decrypt a 6699 AES-GCM discovery frame. Matches tuyapi MessageParser + Cipher._decrypt35.
 */
function decryptGcmDiscovery(msg: Buffer): string {
  const len = msg.length
  // Payload for decrypt starts after 4-byte prefix and excludes 4-byte footer
  const data = msg.slice(4, len - 4)
  const header = data.slice(0, 14)
  const iv = data.slice(14, 26)
  const tag = data.slice(data.length - 16)
  const ciphertext = data.slice(26, data.length - 16)

  const decipher = crypto.createDecipheriv('aes-128-gcm', UDP_KEY, iv)
  decipher.setAuthTag(tag)
  decipher.setAAD(header)
  let result = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  // Device frames typically prepend a 4-byte return code; discovery may omit it
  if (result.length >= 4 && result[0] !== 0x7b /* '{' */) {
    result = result.slice(4)
  }

  return result.toString('utf8').replace(/\0+$/g, '')
}

function ipv4Broadcast(address: string, netmask: string): string {
  const addr = address.split('.').map(Number)
  const mask = netmask.split('.').map(Number)
  if (addr.length !== 4 || mask.length !== 4 || addr.some(Number.isNaN) || mask.some(Number.isNaN)) {
    return '255.255.255.255'
  }
  return addr.map((octet, i) => (octet | (~mask[i] & 255)) >>> 0).join('.')
}

function getLocalIPv4s(): LocalIPv4[] {
  let ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>
  try {
    ifaces = os.networkInterfaces() || {}
  } catch {
    return []
  }

  const results: LocalIPv4[] = []
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      const family = addr.family as string | number
      if (family !== 'IPv4' && family !== 4) continue
      if (addr.internal) continue
      if (addr.address.startsWith('169.254.')) continue
      results.push({
        address: addr.address,
        broadcast: ipv4Broadcast(addr.address, addr.netmask),
      })
    }
  }
  return results
}

export default new TuyaDiscovery()
