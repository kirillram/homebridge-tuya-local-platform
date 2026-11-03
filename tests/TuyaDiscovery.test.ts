import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import discovery from '../src/protocol/TuyaDiscovery'
import { createMockLogger } from './helpers'

const UDP_KEY = Buffer.from('6c1ec8e2bb9bb59ab50b0daf649b410a', 'hex')

/**
 * Build a Tuya-style UDP discovery frame (port 6666 unencrypted).
 */
function buildDiscoveryFrame(payload: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(payload))
  // Frame: 0x000055aa (4) + seq(4) + cmd(4) + size(4) + returnCode(4) + json + crc(4) + 0x0000aa55 (4)
  const size = json.length + 12 // returnCode(4) + json + crc(4) + suffix(4)
  const buf = Buffer.alloc(4 + 4 + 4 + 4 + 4 + json.length + 4 + 4)
  buf.writeUInt32BE(0x000055aa, 0) // prefix
  // bytes 4-11: zeros (sequence, cmd)
  buf.writeUInt32BE(size, 12) // size
  buf.writeUInt32BE(0, 16) // return code
  json.copy(buf, 20)
  // skip CRC for simplicity
  buf.writeUInt32BE(0x0000aa55, buf.length - 4) // suffix
  return buf
}

/**
 * Build an encrypted discovery frame for port 6667.
 */
function buildEncryptedDiscoveryFrame(payload: Record<string, unknown>): Buffer {
  const json = JSON.stringify(payload)
  const cipher = crypto.createCipheriv('aes-128-ecb', UDP_KEY, '')
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const size = encrypted.length + 12
  const buf = Buffer.alloc(4 + 4 + 4 + 4 + 4 + encrypted.length + 4 + 4)
  buf.writeUInt32BE(0x000055aa, 0)
  buf.writeUInt32BE(size, 12)
  buf.writeUInt32BE(0, 16)
  encrypted.copy(buf, 20)
  buf.writeUInt32BE(0x0000aa55, buf.length - 4)
  return buf
}

// Mock dgram so no actual UDP sockets are opened
vi.mock('dgram', () => {
  const { EventEmitter } = require('events')
  const createSocket = vi.fn(() => {
    const socket = new EventEmitter()
    ;(socket as any).bind = vi.fn((port: number, cb: () => void) => cb())
    ;(socket as any).close = vi.fn()
    ;(socket as any).setBroadcast = vi.fn()
    ;(socket as any).send = vi.fn()
    ;(socket as any).removeAllListeners = vi.fn(() => socket)
    return socket
  })
  return { default: { createSocket }, createSocket }
})

vi.mock('os', () => ({
  default: {
    networkInterfaces: () => ({
      en0: [
        {
          address: '192.168.1.150',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.1.150/24',
        },
      ],
    }),
  },
}))

/**
 * Build a 6699 AES-GCM discovery frame (protocol 3.5).
 */
function buildGcmDiscoveryFrame(payload: Record<string, unknown>, includeRetcode = true): Buffer {
  const json = Buffer.from(JSON.stringify(payload))
  const plaintext = includeRetcode ? Buffer.concat([Buffer.alloc(4), json]) : json

  const header = Buffer.alloc(18)
  header.writeUInt32BE(0x00006699, 0)
  header.writeUInt16BE(0, 4)
  header.writeUInt32BE(1, 6)
  header.writeUInt32BE(0x13, 10) // UDP_NEW
  header.writeUInt32BE(plaintext.length + 28, 14)

  const iv = Buffer.from('123456789012') // 12 bytes
  const cipher = crypto.createCipheriv('aes-128-gcm', UDP_KEY, iv)
  cipher.setAAD(header.slice(4, 18))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([header, iv, encrypted, tag, Buffer.from([0x00, 0x00, 0x99, 0x66])])
}

function decryptGcmFrame(msg: Buffer): string {
  const data = msg.slice(4, msg.length - 4)
  const header = data.slice(0, 14)
  const iv = data.slice(14, 26)
  const tag = data.slice(data.length - 16)
  const ciphertext = data.slice(26, data.length - 16)
  const decipher = crypto.createDecipheriv('aes-128-gcm', UDP_KEY, iv)
  decipher.setAuthTag(tag)
  decipher.setAAD(header)
  let result = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (result.length >= 4 && result[0] !== 0x7b) result = result.slice(4)
  return result.toString('utf8').replace(/\0+$/g, '')
}

describe('TuyaDiscovery', () => {
  let log: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    // Reset singleton state between tests
    discovery.discovered.clear()
    discovery.limitedIds = []
    discovery.removeAllListeners()
    log = createMockLogger()
    vi.clearAllMocks()
  })

  it('should be an EventEmitter', () => {
    expect(discovery).toBeInstanceOf(require('events').EventEmitter)
  })

  it('should store limited IDs from start options', () => {
    discovery.start({ log, ids: ['device1', 'device2'] })
    expect(discovery.limitedIds).toEqual(['device1', 'device2'])
    discovery.stop()
  })

  it('should clear previous state when clear option is set', () => {
    discovery.start({ log, ids: ['old-device'] })
    discovery.discovered.set('old-device', '10.0.0.1')

    discovery.start({ log, ids: ['new-device'], clear: true })
    expect(discovery.discovered.size).toBe(0)
    expect(discovery.limitedIds).toEqual(['new-device'])
    discovery.stop()
  })

  describe('_onDgramMessage (via public simulation)', () => {
    it('should reject messages shorter than 16 bytes', () => {
      discovery.start({ log })
      const info = { address: '192.168.1.1', port: 6666, family: 'IPv4', size: 0 }
      ;(discovery as any)._onDgramMessage(6666, Buffer.alloc(10), info)
      expect(log.error).toHaveBeenCalled()
      discovery.stop()
    })

    it('should reject messages with invalid prefix', () => {
      discovery.start({ log })
      const msg = Buffer.alloc(20)
      msg.writeUInt32BE(0xdeadbeef, 0)
      msg.writeUInt32BE(0x0000aa55, 16)
      const info = { address: '192.168.1.1', port: 6666, family: 'IPv4', size: 20 }
      ;(discovery as any)._onDgramMessage(6666, msg, info)
      expect(log.error).toHaveBeenCalled()
      discovery.stop()
    })

    it('should parse unencrypted discovery on port 6666 and emit discover', () => {
      discovery.start({ log, ids: ['abc123'] })
      const discoverSpy = vi.fn()
      discovery.on('discover', discoverSpy)

      const payload = { gwId: 'abc123', ip: '192.168.1.50', active: 2, version: '3.3' }
      const frame = buildDiscoveryFrame(payload)
      const info = { address: '192.168.1.50', port: 6666, family: 'IPv4', size: frame.length }

      ;(discovery as any)._onDgramMessage(6666, frame, info)

      expect(discoverSpy).toHaveBeenCalledTimes(1)
      const discovered = discoverSpy.mock.calls[0][0]
      expect(discovered.id).toBe('abc123')
      expect(discovered.ip).toBe('192.168.1.50')
      expect(discovery.discovered.has('abc123')).toBe(true)
      discovery.stop()
    })

    it('should not emit discover twice for the same device', () => {
      discovery.start({ log, ids: ['abc123'] })
      const discoverSpy = vi.fn()
      discovery.on('discover', discoverSpy)

      const payload = { gwId: 'abc123', ip: '192.168.1.50', active: 2, version: '3.3' }
      const frame = buildDiscoveryFrame(payload)
      const info = { address: '192.168.1.50', port: 6666, family: 'IPv4', size: frame.length }

      ;(discovery as any)._onDgramMessage(6666, frame, info)
      ;(discovery as any)._onDgramMessage(6666, frame, info)

      expect(discoverSpy).toHaveBeenCalledTimes(1)
      discovery.stop()
    })

    it('should parse encrypted discovery on port 6667', () => {
      discovery.start({ log, ids: ['enc-device'] })
      const discoverSpy = vi.fn()
      discovery.on('discover', discoverSpy)

      const payload = { gwId: 'enc-device', ip: '192.168.1.60', version: '3.4' }
      const frame = buildEncryptedDiscoveryFrame(payload)
      const info = { address: '192.168.1.60', port: 6667, family: 'IPv4', size: frame.length }

      ;(discovery as any)._onDgramMessage(6667, frame, info)

      expect(discoverSpy).toHaveBeenCalledTimes(1)
      expect(discoverSpy.mock.calls[0][0].id).toBe('enc-device')
      discovery.stop()
    })

    it('should parse 3.5 GCM discovery on port 6667', () => {
      discovery.start({ log, ids: ['gcm-device'] })
      const discoverSpy = vi.fn()
      discovery.on('discover', discoverSpy)

      const payload = { gwId: 'gcm-device', ip: '192.168.1.70', version: '3.5' }
      const frame = buildGcmDiscoveryFrame(payload)
      const info = { address: '192.168.1.70', port: 6667, family: 'IPv4', size: frame.length }

      ;(discovery as any)._onDgramMessage(6667, frame, info)

      expect(discoverSpy).toHaveBeenCalledTimes(1)
      expect(discoverSpy.mock.calls[0][0].id).toBe('gcm-device')
      expect(discoverSpy.mock.calls[0][0].version).toBe('3.5')
      discovery.stop()
    })

    it('should parse 3.5 GCM discovery on port 7000', () => {
      discovery.start({ log, ids: ['solicit-device'] })
      const discoverSpy = vi.fn()
      discovery.on('discover', discoverSpy)

      const payload = { gwId: 'solicit-device', ip: '192.168.1.80', version: '3.5' }
      const frame = buildGcmDiscoveryFrame(payload)
      const info = { address: '192.168.1.80', port: 7000, family: 'IPv4', size: frame.length }

      ;(discovery as any)._onDgramMessage(7000, frame, info)

      expect(discoverSpy).toHaveBeenCalledTimes(1)
      expect(discoverSpy.mock.calls[0][0].id).toBe('solicit-device')
      discovery.stop()
    })

    it('should silently ignore app solicitation echoes on port 7000', () => {
      discovery.start({ log })
      const discoverSpy = vi.fn()
      discovery.on('discover', discoverSpy)

      // Own (or Smart Life app) UDP/7000 broadcasts look like this and must not be errors
      const frame = buildGcmDiscoveryFrame({ from: 'app', ip: ' ' }, false)
      const info = { address: '192.168.1.150', port: 7000, family: 'IPv4', size: frame.length }

      ;(discovery as any)._onDgramMessage(7000, frame, info)

      expect(discoverSpy).not.toHaveBeenCalled()
      expect(log.error).not.toHaveBeenCalled()
      discovery.stop()
    })

    it('should use the sender address when a 3.5 reply has gwId but a blank ip', () => {
      discovery.start({ log, ids: ['blank-ip-device'] })
      const discoverSpy = vi.fn()
      discovery.on('discover', discoverSpy)

      const frame = buildGcmDiscoveryFrame({ gwId: 'blank-ip-device', ip: ' ', version: '3.5' })
      const info = { address: '192.168.1.80', port: 7000, family: 'IPv4', size: frame.length }

      ;(discovery as any)._onDgramMessage(7000, frame, info)

      expect(discoverSpy).toHaveBeenCalledTimes(1)
      expect(discoverSpy.mock.calls[0][0].id).toBe('blank-ip-device')
      expect(discoverSpy.mock.calls[0][0].ip).toBe('192.168.1.80')
      discovery.stop()
    })

    it('should advertise a real local IPv4 in 3.5 solicitation packets', () => {
      discovery.start({ log })
      const socket = (discovery as any)._servers[7000]
      ;(discovery as any)._solicit()

      expect(socket.send).toHaveBeenCalled()
      const packet: Buffer = socket.send.mock.calls[socket.send.mock.calls.length - 1][0]
      expect(packet.readUInt32BE(0)).toBe(0x00006699)
      expect(packet.readUInt32BE(10)).toBe(0x25) // REQ_DEVINFO

      const json = JSON.parse(decryptGcmFrame(packet))
      expect(json.from).toBe('app')
      expect(json.ip).toBe('192.168.1.150')
      expect(socket.send.mock.calls.some((call: any[]) => call[4] === '192.168.1.255')).toBe(true)
      discovery.stop()
    })

    it('should silently ignore undecryptable messages on port 6667', () => {
      discovery.start({ log })
      const discoverSpy = vi.fn()
      discovery.on('discover', discoverSpy)

      // Frame with random encrypted bytes that won't decrypt with UDP_KEY
      const garbage = crypto.randomBytes(32)
      const size = garbage.length + 12
      const buf = Buffer.alloc(4 + 4 + 4 + 4 + 4 + garbage.length + 4 + 4)
      buf.writeUInt32BE(0x000055aa, 0)
      buf.writeUInt32BE(size, 12)
      buf.writeUInt32BE(0, 16)
      garbage.copy(buf, 20)
      buf.writeUInt32BE(0x0000aa55, buf.length - 4)

      const info = { address: '192.168.1.70', port: 6667, family: 'IPv4', size: buf.length }
      ;(discovery as any)._onDgramMessage(6667, buf, info)

      expect(discoverSpy).not.toHaveBeenCalled()
      // Should NOT log any errors — just silently return
      expect(log.error).not.toHaveBeenCalled()
      discovery.stop()
    })
  })

  describe('auto-end when all limited IDs discovered', () => {
    it('should emit end when all limited IDs are discovered', async () => {
      discovery.start({ log, ids: ['dev1'] })
      // Spy on emit because end() calls removeAllListeners() before emitting 'end'
      const emitSpy = vi.spyOn(discovery, 'emit')

      const payload = { gwId: 'dev1', ip: '192.168.1.50', version: '3.3' }
      const frame = buildDiscoveryFrame(payload)
      const info = { address: '192.168.1.50', port: 6666, family: 'IPv4', size: frame.length }
      ;(discovery as any)._onDgramMessage(6666, frame, info)

      // end is emitted via process.nextTick
      await new Promise((r) => setTimeout(r, 50))
      expect(emitSpy).toHaveBeenCalledWith('end')
      emitSpy.mockRestore()
    })
  })
})
