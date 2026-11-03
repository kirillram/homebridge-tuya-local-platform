import { describe, it, expect, vi } from 'vitest'
import TWLightAccessory from '../src/accessories/TWLight.accessory'
import {
  createMockLogger,
  createMockTuyaDevice,
  createMockPlatformAccessory,
  createMockCharacteristic,
  createMockService,
  createMockCategories,
} from './helpers'

function hapRangeGuard(char: any, min: number, max: number) {
  char.updateValue = vi.fn((value: unknown) => {
    if (typeof value === 'number' && (value < min || value > max || !Number.isFinite(value))) {
      throw new Error(`invalid characteristic value ${value}`)
    }
    if (value === undefined) {
      throw new Error('invalid characteristic value')
    }
    char.value = value
    return char
  })
}

function createTWLight(contextOverrides = {}) {
  const device = createMockTuyaDevice({
    name: 'Test TW Light',
    type: 'twlight',
    version: '3.5',
    ...contextOverrides,
  } as any)

  const accessory = createMockPlatformAccessory(contextOverrides)
  const log = createMockLogger()
  const Characteristic = createMockCharacteristic()
  const Service = createMockService()

  const platform = {
    log,
    api: {
      hap: {
        Characteristic,
        Service,
        Categories: createMockCategories(),
        AdaptiveLightingController: class {
          constructor() {
            throw new Error('adaptive lighting should not crash registration')
          }
        },
        versionGreaterOrEqual: () => true,
      },
      versionGreaterOrEqual: () => true,
    },
    registerPlatformAccessories: vi.fn(),
  }

  const light = new TWLightAccessory(platform, accessory, device, (contextOverrides as any).__isNew ?? false)

  return { light, device, accessory, platform, log, Characteristic, Service }
}

describe('TWLightAccessory', () => {
  it('does not throw when registering characteristics before any DPS arrive', () => {
    const { light, accessory, Service, Characteristic } = createTWLight()
    light._registerPlatformAccessory()
    const service = accessory.getService(Service.Lightbulb)!
    hapRangeGuard(service.getCharacteristic(Characteristic.On), 0, 1)
    hapRangeGuard(service.getCharacteristic(Characteristic.Brightness), 0, 100)
    hapRangeGuard(service.getCharacteristic(Characteristic.ColorTemperature), 0, 600)

    expect(() => light._registerCharacteristics({})).not.toThrow()
  })

  it('keeps DPs and characteristics set during registration once construction finishes', async () => {
    const { light, log, device } = createTWLight({ __isNew: true, dpColorTemperature: 4 } as any)
    await Promise.resolve()

    expect(log.error).not.toHaveBeenCalled()
    // Subclass field initializers run after super(); registration must not happen before them
    expect(light.dpPower).toBe('1')
    expect(light.dpColorTemperature).toBe('4')
    expect(light.characteristicColorTemperature).toBeDefined()
    expect(device._connect).toHaveBeenCalled()
  })
})
