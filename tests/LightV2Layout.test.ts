import { describe, it, expect, vi } from 'vitest'
import RGBTWLightAccessory from '../src/accessories/RGBTWLight.accessory'
import TWLightAccessory from '../src/accessories/TWLight.accessory'
import SimpleLightAccessory from '../src/accessories/SimpleLight.accessory'
import {
  createMockLogger,
  createMockTuyaDevice,
  createMockPlatformAccessory,
  createMockCharacteristic,
  createMockService,
  createMockCategories,
} from './helpers'

// DPs reported by a real Tuya v2 bulb (category "dj", protocol 3.5)
const V2_STATE = {
  '20': true,
  '21': 'white',
  '22': 1000,
  '23': 1000,
  '24': '000003e803e8',
  '25': '000e0d0000000000000000c80000',
  '26': 0,
  '34': false,
}

async function createLight(Accessory: any, contextOverrides: Record<string, unknown> = {}) {
  const device = createMockTuyaDevice({ name: 'Lamp', version: '3.5', ...contextOverrides } as any)
  device.connected = true
  const accessory = createMockPlatformAccessory()
  const log = createMockLogger()
  const Characteristic = createMockCharacteristic()
  const Service = createMockService()
  const platform = {
    log,
    api: { hap: { Characteristic, Service, Categories: createMockCategories() } },
    registerPlatformAccessories: vi.fn(),
  }

  const light = new Accessory(platform, accessory, device, true)
  await Promise.resolve() // let the deferred _setup register services and handlers

  const service = accessory.getService(Service.Lightbulb)!
  const char = (type: string) => service.getCharacteristic(type)

  // What TuyaAccessory does on a 3.5 connection: an empty change first, then the DP report
  const report = (state: Record<string, unknown>) => {
    device.emit('change', {}, {})
    device.state = { ...state }
    device.emit('change', { ...state }, device.state)
  }

  return { light, device, log, Characteristic, char, report }
}

describe('Tuya v2 light DP layout detection', () => {
  it('RGBTWLight sends on/off to DP 20 when the bulb reports the v2 layout', async () => {
    const { device, Characteristic, char, report } = await createLight(RGBTWLightAccessory)
    report(V2_STATE)

    await char(Characteristic.On)._onSet(false)

    expect(device.update).toHaveBeenCalledWith({ '20': false })
  })

  it('RGBTWLight reflects the v2 power DP in HomeKit', async () => {
    const { Characteristic, char, report } = await createLight(RGBTWLightAccessory)
    report(V2_STATE)

    expect(char(Characteristic.On).value).toBe(true)
    expect(await char(Characteristic.On)._onGet()).toBe(true)
  })

  it('RGBTWLight scales brightness to the v2 range 10-1000', async () => {
    const { device, Characteristic, char, report } = await createLight(RGBTWLightAccessory)
    report({ ...V2_STATE, '22': 500 })

    await char(Characteristic.Brightness)._onSet(100)
    expect(device.update).toHaveBeenCalledWith({ '22': 1000 })

    await char(Characteristic.Brightness)._onSet(1)
    expect(device.update).toHaveBeenCalledWith({ '22': 10 })
  })

  it('RGBTWLight sends colour in the 12-character HSB format to DP 24', async () => {
    vi.useFakeTimers()
    try {
      const { device, Characteristic, char, report } = await createLight(RGBTWLightAccessory)
      report(V2_STATE)

      const hue = char(Characteristic.Hue)._onSet(180)
      const sat = char(Characteristic.Saturation)._onSet(100)
      await vi.advanceTimersByTimeAsync(600)
      await Promise.all([hue, sat])

      expect(device.update).toHaveBeenCalledWith({ '21': 'colour' })
      expect(device.update).toHaveBeenCalledWith({ '24': '00b403e803e8' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('RGBTWLight keeps DPs that are set explicitly in the config', async () => {
    const { device, Characteristic, char, report } = await createLight(RGBTWLightAccessory, { dpPower: 1 })
    report({ ...V2_STATE, '1': false })

    await char(Characteristic.On)._onSet(true)

    expect(device.update).toHaveBeenCalledWith({ '1': true })
  })

  it('RGBTWLight keeps the legacy layout for bulbs that report DP 1', async () => {
    const { device, Characteristic, char, report } = await createLight(RGBTWLightAccessory)
    report({ '1': false, '2': 'white', '3': 255, '4': 255, '5': '' })

    await char(Characteristic.On)._onSet(true)

    expect(device.update).toHaveBeenCalledWith({ '1': true })
  })

  it('logs the detected layout and a ready signature with real DPs', async () => {
    const { log, report } = await createLight(RGBTWLightAccessory)
    report(V2_STATE)

    const lines = [...log.mock.calls, ...log.info.mock.calls].map((args: unknown[]) => args.join(' '))
    expect(lines.some((line) => line.includes('Tuya v2') && line.includes('power 20'))).toBe(true)
    expect(lines.some((line) => line.startsWith('Ready to handle') && line.includes('"20":true'))).toBe(true)
    expect(lines.some((line) => line.startsWith('Ready to handle') && line.includes('{}'))).toBe(false)
  })

  it('TWLight sends power and brightness to DPs 20 and 22', async () => {
    const { device, Characteristic, char, report } = await createLight(TWLightAccessory)
    report({ '20': true, '21': 'white', '22': 500, '23': 0 })

    await char(Characteristic.On)._onSet(false)
    await char(Characteristic.Brightness)._onSet(100)

    expect(device.update).toHaveBeenCalledWith({ '20': false })
    expect(device.update).toHaveBeenCalledWith({ '22': 1000 })
  })

  it('SimpleLight sends power to DP 20', async () => {
    const { device, Characteristic, char, report } = await createLight(SimpleLightAccessory)
    report({ '20': false, '21': 'white' })

    await char(Characteristic.On)._onSet(true)

    expect(device.update).toHaveBeenCalledWith({ '20': true })
  })
})
