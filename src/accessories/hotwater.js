import { CMD_HOTWATER } from '../navien/const.js';
import { BoilerAccessory, clamp } from './base.js';

const OFF = 0;
const HEAT = 1;
const NAME = 'hotWaterTemperatureSetting'; // feature `{NAME}Use` and status key
const RANGE = 'hotWater'; // feature `{RANGE}TemperatureMin/Max`

/**
 * 온수 (domestic hot water) setpoint. HomeKit has no water heater type, so this
 * is a heat-only thermostat. It is a separate accessory so it can live in
 * another room than the heating thermostat.
 */
export class HotWaterAccessory extends BoilerAccessory {
  static isSupported(boiler, config) {
    return (
      config.hotWater !== false &&
      boiler.supports(NAME) &&
      !boiler.isLevel(NAME) && // level (1-3) boilers have no °C setpoint to show
      boiler.range(RANGE) !== null
    );
  }

  constructor(platform, accessory, boiler) {
    super(platform, accessory, boiler);
    this._pending = null;
    this.configure();
  }

  configure() {
    const { Service, Characteristic } = this.hap;
    this.configureInformation();
    const range = this.boiler.range(RANGE);
    const service = this.service(Service.Thermostat, '온수', 'hotwater');
    this.thermostat = service;

    service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({ validValues: [OFF, HEAT] })
      .onGet(() => this.read(() => this.state()));
    // Hot water follows the boiler's power; it has no switch of its own.
    service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(HEAT)
      .setProps({ validValues: [HEAT] })
      .onGet(() => HEAT)
      .onSet(() => {});
    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.read(() => this.currentTemperature()));
    const target = service.getCharacteristic(Characteristic.TargetTemperature);
    // The default value (10) can lie outside the boiler's range; place it inside before narrowing the props.
    target.value = this.targetTemperature();
    target
      .setProps({ minValue: range.min, maxValue: range.max, minStep: this.boiler.step(NAME) })
      .onGet(() => this.read(() => this.targetTemperature()))
      .onSet((value) => this.setTargetTemperature(value));
    target.updateValue(this.targetTemperature());
    service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .setProps({ validValues: [Characteristic.TemperatureDisplayUnits.CELSIUS] })
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => {});

    this.update();
  }

  state() {
    return this.boiler.isOn ? HEAT : OFF;
  }

  targetTemperature() {
    const range = this.boiler.range(RANGE);
    return clamp(this.boiler.value(NAME) ?? range.min, range);
  }

  /** NR-35D / NR-40D do not report the actual water temperature; show the setpoint instead. */
  currentTemperature() {
    return this.boiler.value('hotWaterTemperature') ?? this.targetTemperature();
  }

  update() {
    const { Characteristic } = this.hap;
    if (!this.boiler.hasStatus) {
      return;
    }
    this.thermostat.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.state());
    this.thermostat.updateCharacteristic(Characteristic.CurrentTemperature, this.currentTemperature());
    if (this._pending === null) {
      this.thermostat.updateCharacteristic(Characteristic.TargetTemperature, this.targetTemperature());
    }
  }

  setTargetTemperature(value) {
    this._pending = value;
    this.debounce('temperature', () =>
      this.enqueue('set hot water temperature', async () => {
        const celsius = clamp(this._pending, this.boiler.range(RANGE));
        this._pending = null;
        await this.send(CMD_HOTWATER, [this.boiler.encode(NAME, celsius)]);
      }),
    );
  }
}
