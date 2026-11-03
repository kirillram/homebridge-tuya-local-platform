import type { Characteristic as CharacteristicType, WithUUID } from 'homebridge'
import type { EnergyCharacteristicsMap } from '../types'

const createEnergyCharacteristics = (Characteristic: any): EnergyCharacteristicsMap => {
  // hap-nodejs 1+ (Homebridge 2) no longer hangs Formats/Perms off Characteristic; the values are HAP wire constants
  const FLOAT = Characteristic.Formats?.FLOAT ?? 'float'
  const READ_NOTIFY = [Characteristic.Perms?.PAIRED_READ ?? 'pr', Characteristic.Perms?.NOTIFY ?? 'ev']

  class EnergyCharacteristic extends Characteristic {
    static readonly UUID: string = ''

    constructor(displayName: string, UUID: string) {
      super(displayName, UUID)
      this.setProps({
        format: FLOAT,
        perms: READ_NOTIFY,
      })
      this.value = this.getDefaultValue()
    }
  }

  class Amperes extends EnergyCharacteristic {
    static readonly UUID = 'E863F126-079E-48FF-8F27-9C2605A29F52'

    constructor() {
      super('Amperes', Amperes.UUID)
      this.setProps({
        format: FLOAT,
        unit: 'A' as any,
        perms: READ_NOTIFY,
        minStep: 0.001,
      })
      this.value = this.getDefaultValue()
    }
  }

  class KilowattHours extends EnergyCharacteristic {
    static readonly UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52'

    constructor() {
      super('Kilowatt Hours', KilowattHours.UUID)
      this.setProps({
        format: FLOAT,
        unit: 'kWh' as any,
        perms: READ_NOTIFY,
        minStep: 0.001,
      })
      this.value = this.getDefaultValue()
    }
  }

  class KilowattVoltAmpereHour extends EnergyCharacteristic {
    static readonly UUID = 'E863F127-079E-48FF-8F27-9C2605A29F52'

    constructor() {
      super('Kilowatt Volt Ampere Hour', KilowattVoltAmpereHour.UUID)
      this.setProps({
        format: FLOAT,
        unit: 'kVAh' as any,
        perms: READ_NOTIFY,
        minStep: 0.001,
      })
      this.value = this.getDefaultValue()
    }
  }

  class VoltAmperes extends EnergyCharacteristic {
    static readonly UUID = 'E863F110-079E-48FF-8F27-9C2605A29F52'

    constructor() {
      super('Volt Amperes', VoltAmperes.UUID)
      this.setProps({
        format: FLOAT,
        unit: 'VA' as any,
        perms: READ_NOTIFY,
        minStep: 0.001,
      })
      this.value = this.getDefaultValue()
    }
  }

  class Volts extends EnergyCharacteristic {
    static readonly UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52'

    constructor() {
      super('Volts', Volts.UUID)
      this.setProps({
        format: FLOAT,
        unit: 'V' as any,
        perms: READ_NOTIFY,
        minStep: 0.1,
      })
      this.value = this.getDefaultValue()
    }
  }

  class Watts extends EnergyCharacteristic {
    static readonly UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52'

    constructor() {
      super('Watts', Watts.UUID)
      this.setProps({
        format: FLOAT,
        unit: 'W' as any,
        perms: READ_NOTIFY,
        minStep: 0.1,
      })
      this.value = this.getDefaultValue()
    }
  }

  return {
    Amperes: Amperes as unknown as WithUUID<new () => CharacteristicType>,
    KilowattHours: KilowattHours as unknown as WithUUID<new () => CharacteristicType>,
    KilowattVoltAmpereHour: KilowattVoltAmpereHour as unknown as WithUUID<new () => CharacteristicType>,
    VoltAmperes: VoltAmperes as unknown as WithUUID<new () => CharacteristicType>,
    Volts: Volts as unknown as WithUUID<new () => CharacteristicType>,
    Watts: Watts as unknown as WithUUID<new () => CharacteristicType>,
  }
}

export default createEnergyCharacteristics
