import type {
  PlatformAccessory,
  Service as HAPService,
  Characteristic as HAPCharacteristic,
  WithUUID,
} from 'homebridge'
import type TuyaAccessory from '../protocol/TuyaAccessory'
import type { DPSState, DPSValue, HAPContext, HomebridgeCallback, HSBColor } from '../types'

class BaseAccessory {
  platform: any
  accessory: PlatformAccessory
  device: TuyaAccessory
  log: any
  hap: HAPContext
  colorFunction?: string
  dpColor!: string

  constructor(...props: any[]) {
    let isNew: boolean
    ;[this.platform, this.accessory, this.device, isNew = true] = [...props]
    this.log = this.platform.log
    this.hap = this.platform.hap || this.platform.api.hap

    this.accessory.on('identify', (...args: any[]) => {
      this.log('%s - identify', this.device.context.name)
      const cb = args.find((arg) => typeof arg === 'function')
      if (cb) cb()
    })

    this.device.once('connect', () => {
      this.log('Connected to', this.device.context.name)
    })

    // Registered before any subclass listener, so DPs are adapted before the first report is applied.
    // 3.4/3.5 connections emit an empty change on connect; wait for the first real DP report.
    let ready = false
    this.device.on('change', (_changes: DPSState, state: DPSState) => {
      if (ready || !state || !Object.keys(state).length) return
      ready = true
      try {
        this._adaptToDeviceState(state)
        // Colour DPs are only known once the device reports; registration runs before that
        if (this.colorFunction === 'Unknown' && this.dpColor && typeof state[this.dpColor] === 'string')
          this._detectColorFunction(state[this.dpColor] as string)
      } catch (err) {
        this.log.error(`Failed to adapt to ${this.device.context.name} DPs: ${(err as Error).message}`)
      }
      this.log(
        `Ready to handle ${this.device.context.name} (${this.device.context.type}:${this.device.context.version}) with signature ${JSON.stringify(state)}`,
      )
    })

    // Subclass field initializers and constructor bodies run only after super() returns, so
    // registering here would read (and then lose) unset DPs/commands. Finish setup once the
    // whole constructor chain is done.
    queueMicrotask(() => this._setup(isNew))
  }

  _setup(isNew: boolean): void {
    try {
      if (isNew) this._registerPlatformAccessory()
      this._registerCharacteristics(this.device.state)
      this.log.info(`Registered HomeKit handlers for ${this.device.context.name}`)
    } catch (err) {
      this.log.error(
        `Failed to register characteristics for ${this.device.context.name}: ${(err as Error).stack || err}`,
      )
    }

    this.device._connect()
  }

  _registerPlatformAccessory(): void {
    this.platform.registerPlatformAccessories(this.accessory)
  }

  _registerCharacteristics(_dps: DPSState): void {
    // Override in subclasses
  }

  /** Called once with the first non-empty DP report, before subclass change listeners see it. */
  _adaptToDeviceState(_state: DPSState): void {
    // Override in subclasses
  }

  /**
   * Tuya v2 lights (category "dj") report switch_led=20, work_mode=21, bright_value_v2=22,
   * temp_value_v2=23 and colour_data_v2=24 instead of the legacy 1-5. When the device reports
   * that layout, move every DP the user didn't configure to its v2 number and use v2 ranges.
   */
  _adoptV2LightLayout(state: DPSState, layout: Record<string, string>): void {
    if (state['20'] === undefined || state['1'] !== undefined) return

    const context = this.device.context as any
    const self = this as any
    const adopted: string[] = []
    for (const [field, dp] of Object.entries(layout)) {
      if (this._getCustomDP(context[field])) continue
      self[field] = dp
      adopted.push(
        `${field
          .replace(/^dp/, '')
          .replace(/^ColorTemperature$/, 'color temperature')
          .toLowerCase()} ${dp}`,
      )
    }
    if (!adopted.length) return

    // bright_value_v2 is 10-1000 and temp_value_v2 is 0-1000
    if (!context.scaleBrightness) context.scaleBrightness = 1000
    if (!context.minBrightness) context.minBrightness = 10
    if (!context.scaleWhiteColor) context.scaleWhiteColor = 1000

    this.log.info(`Detected Tuya v2 light DPs for ${context.name}: ${adopted.join(', ')}`)
  }

  /**
   * Attach GET/SET handlers using onGet/onSet when HAP supports them, else legacy on('get')/on('set').
   * Only one style is registered: HAP warns on every request when both are present.
   *
   * GET never fails — a missing/invalid value falls back to the last known one, so HomeKit
   * doesn't mark the accessory "No Response" while the device is still connecting.
   * SET failures (device offline, write failed) are reported to HomeKit as a communication failure.
   */
  _bind(
    characteristic: any,
    getHandler?: (callback: HomebridgeCallback) => void,
    setHandler?: (value: any, callback: HomebridgeCallback) => void,
  ): any {
    const modern = typeof characteristic.onGet === 'function' && typeof characteristic.onSet === 'function'

    if (getHandler) {
      const runGet = () =>
        new Promise((resolve) => {
          let settled = false
          const done: HomebridgeCallback = (_err, value) => {
            if (settled) return
            settled = true
            if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) {
              const fallback = characteristic.value
              resolve(fallback === undefined || fallback === null ? 0 : fallback)
            } else {
              resolve(value)
            }
          }
          try {
            getHandler(done)
          } catch {
            done(null, characteristic.value ?? 0)
          }
        })

      if (modern) characteristic.onGet(() => runGet())
      else
        characteristic.on('get', (callback: HomebridgeCallback) => {
          runGet().then((value) => callback(null, value as any))
        })
    }

    if (setHandler) {
      const runSet = (value: any) =>
        new Promise<void>((resolve, reject) => {
          let settled = false
          const done: HomebridgeCallback = (err) => {
            if (settled) return
            settled = true
            if (err) reject(err)
            else resolve()
          }
          try {
            setHandler(value, done)
          } catch (err) {
            this.log.error(`Set handler failed for ${this.device.context.name}: ${(err as Error).message}`)
            done(err as Error)
          }
        })

      if (modern)
        characteristic.onSet((value: any) =>
          runSet(value).catch(() => {
            throw this._communicationFailure()
          }),
        )
      else
        characteristic.on('set', (value: any, callback?: HomebridgeCallback) => {
          runSet(value).then(
            () => typeof callback === 'function' && callback(null),
            (err) => typeof callback === 'function' && callback(err instanceof Error ? err : new Error(String(err))),
          )
        })
    }

    return characteristic
  }

  /** HAP status HomeKit shows as "No Response"; thrown from onSet when a write can't reach the device. */
  _communicationFailure(): unknown {
    const hap = this.hap as any
    const status = hap?.HAPStatus?.SERVICE_COMMUNICATION_FAILURE ?? -70402
    return typeof hap?.HapStatusError === 'function' ? new hap.HapStatusError(status) : status
  }

  _checkServiceName(service: HAPService, name: string): void {
    const { Characteristic } = this.hap

    if (service.displayName !== name) {
      const nameCharacteristic =
        service.getCharacteristic(Characteristic.Name) || service.addCharacteristic(Characteristic.Name)
      nameCharacteristic.setValue(name)
      service.displayName = name
    }
  }

  _removeCharacteristic(service: HAPService, characteristicType: WithUUID<new () => HAPCharacteristic>): void {
    if (!service || !characteristicType || !(characteristicType as any).UUID) return

    service.characteristics.some((characteristic) => {
      if (!characteristic || characteristic.UUID !== (characteristicType as any).UUID) return false
      service.removeCharacteristic(characteristic)
      return true
    })
  }

  _getCustomDP(numeral: unknown): string | false {
    return isFinite(numeral as number) && parseInt(numeral as string) > 0 ? String(numeral) : false
  }

  _coerceBoolean(b: unknown, defaultValue?: boolean): boolean {
    const df = defaultValue || false
    return typeof b === 'boolean'
      ? b
      : typeof b === 'string'
        ? b.toLowerCase().trim() === 'true'
        : typeof b === 'number'
          ? b !== 0
          : df
  }

  getState(dp: string | string[], callback: HomebridgeCallback): void {
    // Never pass Error to HAP GET — HomeKit treats it as SERVICE_COMMUNICATION_FAILURE
    // and the Home app sticks on "No Response", then stops sending SET requests.
    const _callback = () => {
      try {
        if (Array.isArray(dp)) {
          const ret: DPSState = {}
          dp.forEach((p) => {
            const value = this.device.state[p]
            ret[p] = value === undefined || value === null ? 0 : value
          })
          callback(null, ret as any)
        } else {
          const value = this.device.state[dp]
          callback(null, value === undefined || value === null ? 0 : value)
        }
      } catch {
        callback(null, 0)
      }
    }

    process.nextTick(_callback)
  }

  getPower(dp: string, callback: HomebridgeCallback): void {
    callback(null, this._coerceBoolean(this.device.state[dp], false))
  }

  setPower(dp: string, value: DPSValue, callback?: HomebridgeCallback): void {
    this.setState(dp, this._coerceBoolean(value, false), callback)
  }

  setState(dp: string, value: DPSValue, callback?: HomebridgeCallback): void {
    this.setMultiState({ [dp.toString()]: value }, callback)
  }

  setMultiStateLegacy(dps: DPSState, callback: HomebridgeCallback): void {
    this.setMultiState(dps, callback)
  }

  setMultiState(dps: DPSState, callback?: HomebridgeCallback): void {
    this.log.info(`${this.device.context.name}: set ${JSON.stringify(dps)}`)
    try {
      if (!this.device.connected) {
        this.log.warn(`${this.device.context.name} is not connected; cannot update state`)
        if (callback) callback(new Error('Not connected'))
        return
      }
      let failed = false
      for (const dp in dps) {
        if (dps.hasOwnProperty(dp) && dps[dp] !== this.device.state[dp]) {
          if (!this.device.update({ [dp.toString()]: dps[dp] })) failed = true
        }
      }
      if (failed) {
        this.log.warn(`Failed to update ${this.device.context.name}: ${JSON.stringify(dps)}`)
        if (callback) callback(new Error('Update failed'))
        return
      }
      if (callback) callback(null)
    } catch (err) {
      this.log.error(`Failed to update ${this.device.context.name}: ${(err as Error).stack || err}`)
      if (callback) callback(err as Error)
    }
  }

  getDividedState(dp: string, divisor: number, callback: HomebridgeCallback): void {
    this.getState(dp, (_err, data) => {
      callback(null, this._getDividedState((data as number) ?? 0, divisor))
    })
  }

  _getDividedState(dp: number | string, divisor: number): number {
    return parseFloat(dp as string) / divisor || 0
  }

  _detectColorFunction(value: string | undefined): void {
    this.colorFunction =
      this.device.context.colorFunction &&
      ({ HSB: 'HSB', HEXHSB: 'HEXHSB' } as Record<string, string>)[
        (this.device.context.colorFunction as string).toUpperCase()
      ]
    if (!this.colorFunction && value) {
      this.colorFunction = ({ 12: 'HSB', 14: 'HEXHSB' } as Record<number, string>)[value.length] || 'Unknown'
      if (this.colorFunction)
        this.log.info(
          `Color format for ${this.device.context.name} (${this.device.context.version}) identified as ${this.colorFunction} (length: ${value.length}).`,
        )
    }
    if (!this.colorFunction) {
      this.colorFunction = 'Unknown'
      this.log.info(`Color format for ${this.device.context.name} (${this.device.context.version}) is undetectable.`)
    } else if (this.colorFunction === 'HSB') {
      if (!this.device.context.scaleBrightness) (this.device.context as any).scaleBrightness = 1000
      if (!this.device.context.scaleWhiteColor) (this.device.context as any).scaleWhiteColor = 1000
    }
  }

  convertBrightnessFromHomeKitToTuya(value: number): number {
    const min = (this.device.context as any).minBrightness || 27
    const scale = (this.device.context as any).scaleBrightness || 255
    return Math.round(((scale - min) * value + 100 * min - scale) / 99)
  }

  convertBrightnessFromTuyaToHomeKit(value: number | string): number {
    const min = (this.device.context as any).minBrightness || 27
    const scale = (this.device.context as any).scaleBrightness || 255
    const converted = Math.round((99 * (Number(value) || 0) - 100 * min + scale) / (scale - min))
    if (!Number.isFinite(converted)) return 0
    return Math.min(100, Math.max(0, converted))
  }

  convertRotationSpeedFromHomeKitToTuya(value: number): number | string {
    const max = (this.device.context as any).maxSpeed || 3
    const scale = Math.floor(100 / max)
    return Math.round(value / scale)
  }

  convertRotationSpeedFromTuyaToHomeKit(value: number | string): number {
    const max = (this.device.context as any).maxSpeed || 3
    const scale = Math.max(100 / max)
    return Math.round(Number(value) * scale)
  }

  convertColorTemperatureFromHomeKitToTuya(value: number): number {
    const min = (this.device.context as any).minWhiteColor || 140
    const max = (this.device.context as any).maxWhiteColor || 400
    const scale = (this.device.context as any).scaleWhiteColor || 255
    const adjustedValue = ((value - 71) * (max - min)) / (600 - 71) + 153
    const convertedValue = Math.round(((scale * min) / (max - min)) * (max / adjustedValue - 1))
    return Math.min(scale, Math.max(0, convertedValue))
  }

  convertColorTemperatureFromTuyaToHomeKit(value: number | string): number {
    const min = (this.device.context as any).minWhiteColor || 140
    const max = (this.device.context as any).maxWhiteColor || 400
    const scale = (this.device.context as any).scaleWhiteColor || 255
    const unadjustedValue = max / ((Number(value) * (max - min)) / (scale * min) + 1)
    const convertedValue = Math.round(((unadjustedValue - 153) * (600 - 71)) / (max - min) + 71)
    if (!Number.isFinite(convertedValue)) return 140
    return Math.min(500, Math.max(140, convertedValue))
  }

  /** Colour format in use: the configured one, else the one detected from the device's colour DP. */
  _colorFormat(): string {
    const configured = String((this.device.context as any).colorFunction || '').toUpperCase()
    if (configured === 'HSB' || configured === 'HEXHSB') return configured
    return this.colorFunction || 'HEXHSB'
  }

  convertColorFromHomeKitToTuya(value: Partial<HSBColor>, dpValue?: string): string {
    switch (this._colorFormat()) {
      case 'HSB':
        return this.convertColorFromHomeKitToTuya_HSB(value, dpValue)
      default:
        return this.convertColorFromHomeKitToTuya_HEXHSB(value, dpValue)
    }
  }

  convertColorFromHomeKitToTuya_HEXHSB(value: Partial<HSBColor>, dpValue?: string): string {
    const cached = this.convertColorFromTuya_HEXHSB_ToHomeKit(dpValue || (this.device.state[this.dpColor] as string))
    const h = Number({ ...cached, ...value }.h) || 0
    const s = Number({ ...cached, ...value }.s) || 0
    const b = Number({ ...cached, ...value }.b) || 0
    const hsb =
      h.toString(16).padStart(4, '0') +
      Math.round(2.55 * s)
        .toString(16)
        .padStart(2, '0') +
      Math.round(2.55 * b)
        .toString(16)
        .padStart(2, '0')
    const hNorm = h / 60
    const sNorm = s / 100
    const bNorm = b * 2.55

    const i = Math.floor(hNorm)
    const f = hNorm - i
    const p = bNorm * (1 - sNorm)
    const q = bNorm * (1 - sNorm * f)
    const t = bNorm * (1 - sNorm * (1 - f))
    const rgb = (() => {
      switch (i % 6) {
        case 0:
          return [bNorm, t, p]
        case 1:
          return [q, bNorm, p]
        case 2:
          return [p, bNorm, t]
        case 3:
          return [p, q, bNorm]
        case 4:
          return [t, p, bNorm]
        case 5:
          return [bNorm, p, q]
        default:
          return [bNorm, t, p]
      }
    })().map((c) => Math.round(c).toString(16).padStart(2, '0'))
    const hex = rgb.join('')

    return hex + hsb
  }

  convertColorFromHomeKitToTuya_HSB(value: Partial<HSBColor>, dpValue?: string): string {
    const cached = this.convertColorFromTuya_HSB_ToHomeKit(dpValue || (this.device.state[this.dpColor] as string))
    const h = Number({ ...cached, ...value }.h) || 0
    const s = Number({ ...cached, ...value }.s) || 0
    const b = Number({ ...cached, ...value }.b) || 0
    return (
      h.toString(16).padStart(4, '0') + (10 * s).toString(16).padStart(4, '0') + (10 * b).toString(16).padStart(4, '0')
    )
  }

  convertColorFromTuyaToHomeKit(value: string): HSBColor {
    switch (this._colorFormat()) {
      case 'HSB':
        return this.convertColorFromTuya_HSB_ToHomeKit(value)
      default:
        return this.convertColorFromTuya_HEXHSB_ToHomeKit(value)
    }
  }

  convertColorFromTuya_HEXHSB_ToHomeKit(value: string): HSBColor {
    const [, h, s, b] = (value || '0000000000ffff').match(/^.{6}([0-9a-f]{4})([0-9a-f]{2})([0-9a-f]{2})$/i) || [
      '0',
      '0',
      'ff',
      'ff',
    ]
    return {
      h: Math.min(360, Math.max(0, parseInt(h, 16) || 0)),
      s: Math.min(100, Math.max(0, Math.round(parseInt(s, 16) / 2.55))),
      b: Math.min(100, Math.max(0, Math.round(parseInt(b, 16) / 2.55))),
    }
  }

  convertColorFromTuya_HSB_ToHomeKit(value: string): HSBColor {
    const [, h, s, b] = (value || '000003e803e8').match(/^([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})$/i) || [
      '0',
      '0',
      '3e8',
      '3e8',
    ]
    return {
      h: Math.min(360, Math.max(0, parseInt(h, 16) || 0)),
      s: Math.min(100, Math.max(0, Math.round(parseInt(s, 16) / 10))),
      b: Math.min(100, Math.max(0, Math.round(parseInt(b, 16) / 10))),
    }
  }

  convertHomeKitColorTemperatureToHomeKitColor(value: number): HSBColor {
    const dKelvin = 10000 / value
    const rgb = [
      dKelvin > 66
        ? 351.97690566805693 + 0.114206453784165 * (dKelvin - 55) - 40.25366309332127 * Math.log(dKelvin - 55)
        : 255,
      dKelvin > 66
        ? 325.4494125711974 + 0.07943456536662342 * (dKelvin - 50) - 28.0852963507957 * Math.log(dKelvin - 55)
        : 104.49216199393888 * Math.log(dKelvin - 2) - 0.44596950469579133 * (dKelvin - 2) - 155.25485562709179,
      dKelvin > 66
        ? 255
        : 115.67994401066147 * Math.log(dKelvin - 10) + 0.8274096064007395 * (dKelvin - 10) - 254.76935184120902,
    ].map((v) => Math.max(0, Math.min(255, v)) / 255)
    const max = Math.max(...rgb)
    const min = Math.min(...rgb)
    const d = max - min
    let h = 0
    const s = max ? (100 * d) / max : 0
    const b = 100 * max

    if (d) {
      switch (max) {
        case rgb[0]:
          h = (rgb[1] - rgb[2]) / d + (rgb[1] < rgb[2] ? 6 : 0)
          break
        case rgb[1]:
          h = (rgb[2] - rgb[0]) / d + 2
          break
        default:
          h = (rgb[0] - rgb[1]) / d + 4
          break
      }
      h *= 60
    }
    return {
      h: Math.round(h),
      s: Math.round(s),
      b: Math.round(b),
    }
  }

  adaptiveLightingSupport(): boolean {
    return !!(this.platform.api.versionGreaterOrEqual && this.platform.api.versionGreaterOrEqual('v1.3.0-beta.23'))
  }
}

export default BaseAccessory
