import { describe, it, expect, vi, beforeEach } from 'vitest'
import BaseAccessory from '../src/accessories/Base.accessory'
import {
  createMockLogger,
  createMockTuyaDevice,
  createMockPlatformAccessory,
  createMockCharacteristic,
  createMockService,
  createMockCategories,
} from './helpers'

function createBaseAccessory(deviceOverrides = {}) {
  const device = createMockTuyaDevice(deviceOverrides)
  const accessory = createMockPlatformAccessory({ name: 'Test Device' })
  const log = createMockLogger()

  const platform = {
    log,
    api: {
      hap: {
        Characteristic: createMockCharacteristic(),
        Service: createMockService(),
        Categories: createMockCategories(),
      },
    },
    registerPlatformAccessories: vi.fn(),
  }

  // BaseAccessory constructor calls device._connect() and sets up listeners
  // Create instance (isNew = false to skip _registerPlatformAccessory)
  const base = new BaseAccessory(platform, accessory, device, false)

  return { base, device, accessory, platform, log }
}

describe('BaseAccessory', () => {
  describe('_coerceBoolean', () => {
    let base: BaseAccessory

    beforeEach(() => {
      ;({ base } = createBaseAccessory())
    })

    it('should return boolean values as-is', () => {
      expect(base._coerceBoolean(true)).toBe(true)
      expect(base._coerceBoolean(false)).toBe(false)
    })

    it('should parse string "true" (case-insensitive)', () => {
      expect(base._coerceBoolean('true')).toBe(true)
      expect(base._coerceBoolean('TRUE')).toBe(true)
      expect(base._coerceBoolean(' True ')).toBe(true)
    })

    it('should return false for non-"true" strings', () => {
      expect(base._coerceBoolean('false')).toBe(false)
      expect(base._coerceBoolean('yes')).toBe(false)
      expect(base._coerceBoolean('')).toBe(false)
    })

    it('should convert numbers (0 = false, non-zero = true)', () => {
      expect(base._coerceBoolean(0)).toBe(false)
      expect(base._coerceBoolean(1)).toBe(true)
      expect(base._coerceBoolean(-1)).toBe(true)
    })

    it('should use defaultValue for null/undefined', () => {
      expect(base._coerceBoolean(null)).toBe(false)
      expect(base._coerceBoolean(undefined)).toBe(false)
      expect(base._coerceBoolean(null, true)).toBe(true)
      expect(base._coerceBoolean(undefined, true)).toBe(true)
    })
  })

  describe('_getCustomDP', () => {
    let base: BaseAccessory

    beforeEach(() => {
      ;({ base } = createBaseAccessory())
    })

    it('should return string for positive finite numbers', () => {
      expect(base._getCustomDP(1)).toBe('1')
      expect(base._getCustomDP(103)).toBe('103')
      expect(base._getCustomDP('25')).toBe('25')
    })

    it('should return false for zero, negative, or non-numeric values', () => {
      expect(base._getCustomDP(0)).toBe(false)
      expect(base._getCustomDP(-1)).toBe(false)
      expect(base._getCustomDP(NaN)).toBe(false)
      expect(base._getCustomDP(Infinity)).toBe(false)
      expect(base._getCustomDP(undefined)).toBe(false)
      expect(base._getCustomDP(null)).toBe(false)
    })
  })

  describe('_getDividedState', () => {
    let base: BaseAccessory

    beforeEach(() => {
      ;({ base } = createBaseAccessory())
    })

    it('should divide numeric values by divisor', () => {
      expect(base._getDividedState(100, 10)).toBe(10)
      expect(base._getDividedState(255, 1)).toBe(255)
      expect(base._getDividedState(50, 100)).toBe(0.5)
    })

    it('should handle string numeric values', () => {
      expect(base._getDividedState('200', 10)).toBe(20)
    })

    it('should return 0 for non-numeric or zero divisor result', () => {
      expect(base._getDividedState(0, 10)).toBe(0)
    })
  })

  describe('brightness conversion', () => {
    let base: BaseAccessory

    beforeEach(() => {
      ;({ base } = createBaseAccessory())
    })

    it('should convert brightness from HomeKit (0-100) to Tuya (min-scale)', () => {
      // Default min=27, scale=255
      const tuyaVal = base.convertBrightnessFromHomeKitToTuya(100)
      expect(tuyaVal).toBe(255)

      const tuyaMin = base.convertBrightnessFromHomeKitToTuya(1)
      expect(tuyaMin).toBe(27)
    })

    it('should convert brightness from Tuya to HomeKit', () => {
      const hkVal = base.convertBrightnessFromTuyaToHomeKit(255)
      expect(hkVal).toBe(100)

      const hkMin = base.convertBrightnessFromTuyaToHomeKit(27)
      expect(hkMin).toBe(1)
    })

    it('clamps missing or below-min Tuya brightness to HomeKit 0-100', () => {
      // Default min=27: Tuya 0 / undefined maps below HomeKit 0 and HAP throws
      for (const value of [undefined, null, '', 0, -1]) {
        const hk = base.convertBrightnessFromTuyaToHomeKit(value as any)
        expect(hk).toBeGreaterThanOrEqual(0)
        expect(hk).toBeLessThanOrEqual(100)
        expect(Number.isFinite(hk)).toBe(true)
      }
    })

    it('should be reversible (round-trip)', () => {
      for (const hk of [1, 25, 50, 75, 100]) {
        const tuya = base.convertBrightnessFromHomeKitToTuya(hk)
        const backToHk = base.convertBrightnessFromTuyaToHomeKit(tuya)
        expect(backToHk).toBe(hk)
      }
    })
  })

  describe('color conversion (HEXHSB)', () => {
    let base: BaseAccessory

    beforeEach(() => {
      ;({ base } = createBaseAccessory())
      ;(base.device.context as any).colorFunction = 'HEXHSB'
      base.colorFunction = 'HEXHSB'
      base.dpColor = '5'
      base.device.state['5'] = 'ff00000000ffff'
    })

    it('should convert red from Tuya HEXHSB to HomeKit HSB', () => {
      const hsb = base.convertColorFromTuya_HEXHSB_ToHomeKit('ff00000000ffff')
      expect(hsb.h).toBe(0)
      expect(hsb.s).toBe(100)
      expect(hsb.b).toBe(100)
    })

    it('should handle undefined/empty value with defaults', () => {
      const hsb = base.convertColorFromTuya_HEXHSB_ToHomeKit('')
      expect(hsb).toHaveProperty('h')
      expect(hsb).toHaveProperty('s')
      expect(hsb).toHaveProperty('b')
    })
  })

  describe('color conversion (HSB)', () => {
    let base: BaseAccessory

    beforeEach(() => {
      ;({ base } = createBaseAccessory())
      ;(base.device.context as any).colorFunction = 'HSB'
      base.colorFunction = 'HSB'
      base.dpColor = '5'
      base.device.state['5'] = '000003e803e8'
    })

    it('should convert from Tuya HSB to HomeKit HSB', () => {
      const hsb = base.convertColorFromTuya_HSB_ToHomeKit('000003e803e8')
      expect(hsb.h).toBe(0)
      expect(hsb.s).toBe(100)
      expect(hsb.b).toBe(100)
    })

    it('should produce valid Tuya HSB strings', () => {
      const tuya = base.convertColorFromHomeKitToTuya_HSB({ h: 0, s: 100, b: 100 })
      expect(tuya).toMatch(/^[0-9a-f]{12}$/i)
    })
  })

  describe('color temperature conversion', () => {
    let base: BaseAccessory

    beforeEach(() => {
      ;({ base } = createBaseAccessory())
    })

    it('should stay within HomeKit ColorTemperature bounds (140-500)', () => {
      const hk = base.convertColorTemperatureFromTuyaToHomeKit(0)
      expect(hk).toBeGreaterThanOrEqual(140)
      expect(hk).toBeLessThanOrEqual(500)

      const hk2 = base.convertColorTemperatureFromTuyaToHomeKit(255)
      expect(hk2).toBeGreaterThanOrEqual(140)
      expect(hk2).toBeLessThanOrEqual(500)
    })

    it('should stay within Tuya bounds (0-scale)', () => {
      const tuya = base.convertColorTemperatureFromHomeKitToTuya(71)
      expect(tuya).toBeGreaterThanOrEqual(0)
      expect(tuya).toBeLessThanOrEqual(255)

      const tuya2 = base.convertColorTemperatureFromHomeKitToTuya(600)
      expect(tuya2).toBeGreaterThanOrEqual(0)
      expect(tuya2).toBeLessThanOrEqual(255)
    })
  })

  describe('rotation speed conversion', () => {
    let base: BaseAccessory

    beforeEach(() => {
      ;({ base } = createBaseAccessory())
    })

    it('should convert HomeKit percentage to Tuya speed', () => {
      // Default maxSpeed = 3, scale = 33
      expect(base.convertRotationSpeedFromHomeKitToTuya(33)).toBe(1)
      expect(base.convertRotationSpeedFromHomeKitToTuya(66)).toBe(2)
      expect(base.convertRotationSpeedFromHomeKitToTuya(99)).toBe(3)
    })

    it('should convert Tuya speed to HomeKit percentage', () => {
      expect(base.convertRotationSpeedFromTuyaToHomeKit(1)).toBe(33)
      expect(base.convertRotationSpeedFromTuyaToHomeKit(3)).toBe(100)
    })
  })

  describe('getState / setState', () => {
    let base: BaseAccessory
    let device: any

    beforeEach(() => {
      ;({ base, device } = createBaseAccessory())
      device.connected = true
      device.state = { '1': true, '2': 50, '3': 'auto' }
    })

    it('should return single DP value via callback', async () => {
      const result = await new Promise((resolve) => {
        base.getState('1', (err, val) => resolve({ err, val }))
      })
      expect((result as any).err).toBeNull()
      expect((result as any).val).toBe(true)
    })

    it('should return multiple DP values as object', async () => {
      const result = await new Promise((resolve) => {
        base.getState(['1', '2'], (err, val) => resolve({ err, val }))
      })
      expect((result as any).val).toEqual({ '1': true, '2': 50 })
    })

    it('returns cached state when not connected so HomeKit does not show No Response', async () => {
      device.connected = false
      const result = await new Promise<{ err: any; val: any }>((resolve) => {
        base.getState('1', (err, val) => resolve({ err, val }))
      })
      expect(result.err).toBeNull()
      expect(result.val).toBe(true)
    })

    it('should call device.update on setState', () => {
      device.state['1'] = false
      base.setState('1', true)
      expect(device.update).toHaveBeenCalledWith({ '1': true })
    })

    it('completes a HomeKit set when the DP already matches (no Update failed)', async () => {
      device.state['1'] = true
      const result = await new Promise<{ err: any }>((resolve) => {
        base.setState('1', true, (err) => resolve({ err }))
      })
      expect(device.update).not.toHaveBeenCalled()
      expect(result.err).toBeNull()
    })

    it('does not fail a later set because a previous update returned false', async () => {
      device.update.mockReturnValueOnce(false)
      device.state['1'] = false
      await new Promise<void>((resolve) => {
        base.setState('1', true, () => resolve())
      })

      device.state['1'] = true
      const result = await new Promise<{ err: any }>((resolve) => {
        base.setState('1', true, (err) => resolve({ err }))
      })
      expect(result.err).toBeNull()
    })

    it('reports an error to the HomeKit callback when the device is not connected', async () => {
      const { base, device, log } = createBaseAccessory()
      device.connected = false
      const result = await new Promise<{ err: any }>((resolve) => {
        base.setState('1', true, (err) => resolve({ err }))
      })
      expect(result.err).toBeInstanceOf(Error)
      expect(device.update).not.toHaveBeenCalled()
      expect(log.warn).toHaveBeenCalled()
    })

    it('reports an error when the device rejects the write', async () => {
      device.update.mockReturnValueOnce(false)
      device.state['1'] = false
      const result = await new Promise<{ err: any }>((resolve) => {
        base.setState('1', true, (err) => resolve({ err }))
      })
      expect(result.err).toBeInstanceOf(Error)
    })

    it('getPower never errors to HAP, even when disconnected or DPS are missing', async () => {
      device.connected = false
      device.state = {}
      const result = await new Promise<{ err: any; val: any }>((resolve) => {
        base.getPower('1', (err, val) => resolve({ err, val }))
      })
      expect(result.err).toBeNull()
      expect(result.val).toBe(false)
    })

    it('does not pass undefined to HAP when a DP has no value yet', async () => {
      device.state = {}
      const result = await new Promise<{ err: any; val: any }>((resolve) => {
        base.getState('1', (err, val) => resolve({ err, val }))
      })
      // HAP Characteristic.On throws if the get callback is (null, undefined)
      expect(result.err || result.val !== undefined).toBeTruthy()
    })

    it('completes a Homebridge 2 onSet that is invoked without a callback', async () => {
      const { base } = createBaseAccessory()
      const char: any = {
        value: false,
        on: vi.fn().mockReturnThis(),
        onGet: vi.fn().mockReturnThis(),
        onSet: vi.fn().mockReturnThis(),
      }
      base._bind(
        char,
        (cb) => cb(null, false),
        (_value, cb) => cb(null),
      )
      const onSet = char.onSet.mock.calls[0][0]
      await expect(onSet(true)).resolves.toBeUndefined()
    })

    it('registers only onGet/onSet when HAP supports them (no duplicate legacy listeners)', () => {
      const { base } = createBaseAccessory()
      const char: any = { value: false, on: vi.fn(), onGet: vi.fn(), onSet: vi.fn() }
      base._bind(
        char,
        (cb) => cb(null, false),
        (_value, cb) => cb(null),
      )
      expect(char.onGet).toHaveBeenCalledTimes(1)
      expect(char.onSet).toHaveBeenCalledTimes(1)
      expect(char.on).not.toHaveBeenCalled()
    })

    it('rejects onSet with SERVICE_COMMUNICATION_FAILURE when the write fails', async () => {
      const { base } = createBaseAccessory()
      const char: any = { value: false, on: vi.fn(), onGet: vi.fn(), onSet: vi.fn() }
      base._bind(char, undefined, (_value, cb) => cb(new Error('Not connected')))
      const onSet = char.onSet.mock.calls[0][0]
      await expect(onSet(true)).rejects.toBe(-70402)
    })

    it('uses HapStatusError when HAP provides it', async () => {
      const { base } = createBaseAccessory()
      class HapStatusError extends Error {
        constructor(public hapStatus: number) {
          super('hap status')
        }
      }
      ;(base.hap as any).HapStatusError = HapStatusError
      ;(base.hap as any).HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402 }
      const char: any = { value: false, on: vi.fn(), onGet: vi.fn(), onSet: vi.fn() }
      base._bind(char, undefined, (_value, cb) => cb(new Error('Update failed')))
      const onSet = char.onSet.mock.calls[0][0]
      await expect(onSet(true)).rejects.toMatchObject({ hapStatus: -70402 })
    })

    it('falls back to on(get/set) for older HAP and passes write errors to the callback', async () => {
      const { base } = createBaseAccessory()
      const listeners: Record<string, (...args: any[]) => void> = {}
      const char: any = {
        value: true,
        on: vi.fn((event: string, fn: (...args: any[]) => void) => {
          listeners[event] = fn
          return char
        }),
      }
      base._bind(
        char,
        (cb) => cb(null, undefined),
        (_value, cb) => cb(new Error('Not connected')),
      )
      const got = await new Promise<{ err: any; val: any }>((resolve) =>
        listeners.get((err: any, val: any) => resolve({ err, val })),
      )
      // Missing value falls back to the characteristic's last known value
      expect(got).toEqual({ err: null, val: true })

      const set = await new Promise<any>((resolve) => listeners.set(false, (err: any) => resolve(err)))
      expect(set).toBeInstanceOf(Error)
    })

    it('does not throw when identify is fired without a callback (Homebridge 2)', () => {
      const { accessory } = createBaseAccessory()
      const handler = accessory.on.mock.calls.find((c: any[]) => c[0] === 'identify')?.[1]
      expect(typeof handler).toBe('function')
      expect(() => handler()).not.toThrow()
    })
  })

  describe('convertHomeKitColorTemperatureToHomeKitColor', () => {
    let base: BaseAccessory

    beforeEach(() => {
      ;({ base } = createBaseAccessory())
    })

    it('should return valid HSB with h, s, b properties', () => {
      const result = base.convertHomeKitColorTemperatureToHomeKitColor(300)
      expect(result).toHaveProperty('h')
      expect(result).toHaveProperty('s')
      expect(result).toHaveProperty('b')
      expect(result.h).toBeGreaterThanOrEqual(0)
      expect(result.h).toBeLessThanOrEqual(360)
      expect(result.s).toBeGreaterThanOrEqual(0)
      expect(result.s).toBeLessThanOrEqual(100)
      expect(result.b).toBeGreaterThanOrEqual(0)
      expect(result.b).toBeLessThanOrEqual(100)
    })
  })
})
