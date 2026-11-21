import {
  CMD_GOOUT,
  CMD_HOTWATER_ONLY,
  CMD_INSIDE,
  CMD_ONDOL,
  CMD_POWER_OFF,
  CMD_POWER_ON,
  MODE_DAY_RESERVATION,
  MODE_GOOUT,
  MODE_HOTWATER_ONLY,
  MODE_INSIDE,
  MODE_ONDOL,
  MODE_REPEAT_RESERVATION,
} from '../navien/const.js';
import { BoilerAccessory, TAP_DEBOUNCE_MS, clamp } from './base.js';

const KINDS = {
  // 실내난방: the setpoint is the room air temperature
  inside: { mode: MODE_INSIDE, command: CMD_INSIDE, name: '실내난방' },
  // 온돌난방: the setpoint is the temperature of the water sent to the floor
  ondol: { mode: MODE_ONDOL, command: CMD_ONDOL, name: '온돌난방' },
};
const HEATING_MODES = new Set([MODE_INSIDE, MODE_ONDOL, MODE_REPEAT_RESERVATION, MODE_DAY_RESERVATION]);
// A temperature write right after "turn on" belongs to that request even if the
// boiler has not reported being on yet.
const HEAT_REQUEST_GRACE_MS = 15_000;
const POWER_ON_WAIT_MS = 6_000;

const OFF = 0;
const HEAT = 1;

/** Which heating setpoints get a thermostat, from the feature list and the `heatingMode` setting. */
export function heatingKinds(boiler, heatingMode = 'auto') {
  const available = Object.keys(KINDS).filter((kind) => boiler.supports(kind) && boiler.range(kind));
  if (heatingMode === 'both') {
    return available;
  }
  if (available.includes(heatingMode)) {
    return [heatingMode];
  }
  return available.slice(0, 1);
}

/**
 * Heating: one thermostat (or one per heating mode with `heatingMode: both`),
 * plus optional switches for 외출 (away) and 온수전용 (hot water only).
 *
 * An "Off" thermostat never acts on a temperature write, so nothing turns the
 * boiler on behind the user's back.
 */
export class HeatingAccessory extends BoilerAccessory {
  static isSupported(boiler, config) {
    return heatingKinds(boiler, config.heatingMode).length > 0;
  }

  constructor(platform, accessory, boiler) {
    super(platform, accessory, boiler);
    this._pendingTemperature = new Map();
    this._heatRequestedAt = new Map();
    this.configure();
  }

  configure() {
    const { Service } = this.hap;
    const { config } = this.platform;
    this.configureInformation();

    this.kinds = heatingKinds(this.boiler, config.heatingMode);
    // With two thermostats each one stands for exactly one heating mode.
    this.exclusive = this.kinds.length > 1;
    this.thermostats = this.kinds.map((kind) => ({
      kind,
      service: this.configureThermostat(kind, this.exclusive ? KINDS[kind].name : '난방'),
    }));
    this.removeServices(Service.Thermostat, this.kinds);

    const switches = [];
    this.awaySwitch = null;
    if (config.awaySwitch !== false && this.boiler.supports('goout')) {
      this.awaySwitch = this.configureSwitch('goout', '외출', MODE_GOOUT, () => this.send(CMD_GOOUT));
      switches.push('goout');
    }
    this.hotWaterOnlySwitch = null;
    if (config.hotWaterOnlySwitch === true && this.boiler.supports('hotWater')) {
      this.hotWaterOnlySwitch = this.configureSwitch('hotwater-only', '온수전용', MODE_HOTWATER_ONLY, () =>
        this.sendHotWaterOnly(),
      );
      switches.push('hotwater-only');
    }
    this.removeServices(Service.Switch, switches);

    this.update();
  }

  configureThermostat(kind, name) {
    const { Service, Characteristic } = this.hap;
    const service = this.service(Service.Thermostat, name, kind);
    const range = this.boiler.range(kind);

    service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({ validValues: [OFF, HEAT] })
      .onGet(() => this.read(() => this.heatingState(kind)));
    service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [OFF, HEAT] })
      .onGet(() => this.read(() => this.heatingState(kind)))
      .onSet((value) => this.setHeatingState(kind, value));
    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.read(() => this.currentTemperature()));
    const target = service.getCharacteristic(Characteristic.TargetTemperature);
    // The default value (10) can lie outside the boiler's range; place it inside before narrowing the props.
    target.value = this.targetTemperature(kind);
    target
      .setProps({ minValue: range.min, maxValue: range.max, minStep: this.boiler.step(kind) })
      .onGet(() => this.read(() => this.targetTemperature(kind)))
      .onSet((value) => this.setTargetTemperature(kind, value));
    target.updateValue(this.targetTemperature(kind));
    service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .setProps({ validValues: [Characteristic.TemperatureDisplayUnits.CELSIUS] })
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => {});
    return service;
  }

  configureSwitch(subtype, name, mode, turnOn) {
    const { Service, Characteristic } = this.hap;
    const service = this.service(Service.Switch, name, subtype);
    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.read(() => this.boiler.operationMode === mode))
      .onSet((value) => {
        this.log.debug(`${this.boiler.nickname}: HomeKit set ${name} = ${value}`);
        this.debounce(
          `switch:${subtype}`,
          () => {
            if (value) {
              this.enqueue(name, turnOn);
            } else {
              // Leaving the mode means going back to heating.
              this.enqueue(`${name} off`, async () => {
                if (this.boiler.operationMode === mode) {
                  await this.sendHeat(this.returnKind());
                }
              });
            }
          },
          TAP_DEBOUNCE_MS,
        );
      });
    return { service, mode };
  }

  // -- state ---------------------------------------------------------------

  isHeating(kind) {
    const mode = this.boiler.operationMode;
    return this.exclusive ? mode === KINDS[kind].mode : HEATING_MODES.has(mode);
  }

  heatingState(kind) {
    return this.isHeating(kind) ? HEAT : OFF;
  }

  currentTemperature() {
    return this.boiler.value('insideTemperature') ?? this.targetTemperature(this.kinds[0]);
  }

  targetTemperature(kind) {
    const range = this.boiler.range(kind);
    return clamp(this.boiler.value(`${kind}TemperatureSetting`) ?? range.min, range);
  }

  /** The heating mode to return to when 외출 / 온수전용 is switched off. */
  returnKind() {
    const last = this.accessory.context.lastHeatingKind;
    return this.exclusive && this.kinds.includes(last) ? last : this.kinds[0];
  }

  update() {
    const { Characteristic } = this.hap;
    if (!this.boiler.hasStatus) {
      return;
    }
    for (const [kind, { mode }] of Object.entries(KINDS)) {
      if (this.boiler.operationMode === mode) {
        this.accessory.context.lastHeatingKind = kind;
      }
    }
    for (const { kind, service } of this.thermostats) {
      service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.heatingState(kind));
      service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, this.heatingState(kind));
      service.updateCharacteristic(Characteristic.CurrentTemperature, this.currentTemperature());
      if (!this._pendingTemperature.has(kind)) {
        service.updateCharacteristic(Characteristic.TargetTemperature, this.targetTemperature(kind));
      }
    }
    for (const entry of [this.awaySwitch, this.hotWaterOnlySwitch]) {
      entry?.service.updateCharacteristic(Characteristic.On, this.boiler.operationMode === entry.mode);
    }
  }

  // -- commands ------------------------------------------------------------

  setHeatingState(kind, value) {
    this.log.debug(`${this.boiler.nickname}: HomeKit set ${KINDS[kind].name} state = ${value}`);
    if (value === OFF) {
      this._heatRequestedAt.delete(kind);
    } else {
      // Recorded at once: a temperature written together with "on" must see it.
      this._heatRequestedAt.set(kind, Date.now());
    }
    this.debounce(
      `state:${kind}`,
      () => {
        if (value === OFF) {
          this.enqueue('power off', async () => {
            // With two thermostats, switching off the idle one must not stop the active one.
            if (this.boiler.isOn !== false && this.isHeating(kind)) {
              await this.send(CMD_POWER_OFF);
            }
          });
        } else {
          this.enqueue('heat on', () => this.ensureHeating(kind));
        }
      },
      TAP_DEBOUNCE_MS,
    );
  }

  async ensureHeating(kind) {
    if (this.boiler.isOn === false) {
      await this.send(CMD_POWER_ON);
      // Power-on returns to the mode the boiler was in before it was switched off.
      await this.waitFor(() => this.boiler.isOn === true, POWER_ON_WAIT_MS);
    }
    if (!this.isHeating(kind)) {
      await this.sendHeat(kind);
    }
  }

  /** Switch to a heating mode. The app always sends that mode's current setpoint along. */
  async sendHeat(kind, celsius = this.boiler.value(`${kind}TemperatureSetting`)) {
    if (celsius === null) {
      throw new Error(`the ${KINDS[kind].name} setpoint is not known yet`);
    }
    const value = clamp(celsius, this.boiler.range(kind));
    await this.send(KINDS[kind].command, [this.boiler.encode(kind, value)]);
  }

  async sendHotWaterOnly() {
    const setting = this.boiler.value('hotWaterTemperatureSetting');
    if (setting === null) {
      throw new Error('the hot water setting is not known yet');
    }
    await this.send(CMD_HOTWATER_ONLY, [this.boiler.encode('hotWaterTemperatureSetting', setting)]);
  }

  setTargetTemperature(kind, value) {
    this.log.debug(`${this.boiler.nickname}: HomeKit set ${KINDS[kind].name} temperature = ${value}`);
    this._pendingTemperature.set(kind, value);
    this.debounce(`temperature:${kind}`, () =>
      this.enqueue('set temperature', async () => {
        const celsius = this._pendingTemperature.get(kind);
        this._pendingTemperature.delete(kind);
        const requested = Date.now() - (this._heatRequestedAt.get(kind) ?? 0) < HEAT_REQUEST_GRACE_MS;
        if (!this.isHeating(kind) && !requested) {
          this.log.warn(
            `${this.boiler.nickname}: ignored ${celsius}°C because heating is off (${this.boiler.modeName}). ` +
              'Turn the thermostat on first.',
          );
          this.update();
          return;
        }
        await this.sendHeat(kind, celsius);
      }),
    );
  }
}
