/** Slider drags arrive as a burst of writes; send only the last value. */
export const DEBOUNCE_MS = 1200;
/** HomeKit can deliver one tap as two or three identical writes; act once, on the last value. */
export const TAP_DEBOUNCE_MS = 400;

export function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

/** Shared plumbing for one Homebridge accessory backed by a boiler. */
export class BoilerAccessory {
  constructor(platform, accessory, boiler) {
    this.platform = platform;
    this.accessory = accessory;
    this.boiler = boiler;
    this.hap = platform.api.hap;
    this.log = platform.log;
    this._queue = Promise.resolve();
    this._debounce = new Map();
  }

  get cloud() {
    return this.platform.cloud;
  }

  configureInformation() {
    const { Service, Characteristic } = this.hap;
    this.accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'KD Navien')
      .setCharacteristic(Characteristic.Model, this.boiler.modelName)
      .setCharacteristic(Characteristic.SerialNumber, this.boiler.deviceId);
  }

  /** Get or create a service identified by subtype and keep its name current. */
  service(type, name, subtype) {
    const { Characteristic } = this.hap;
    const service =
      this.accessory.getServiceById(type, subtype) ?? this.accessory.addService(type, name, subtype);
    service.setCharacteristic(Characteristic.Name, name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
      service.setCharacteristic(Characteristic.ConfiguredName, name);
    }
    return service;
  }

  removeServices(type, keepSubtypes) {
    for (const service of this.accessory.services.filter((s) => s.UUID === type.UUID)) {
      if (!keepSubtypes.includes(service.subtype)) {
        this.accessory.removeService(service);
      }
    }
  }

  /** Value for a HomeKit read, or "No Response" while the boiler has not reported yet. */
  read(getter) {
    if (!this.boiler.hasStatus) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return getter();
  }

  /** Commands run one at a time, in the order HomeKit asked for them. */
  enqueue(label, task) {
    this._queue = this._queue.then(task).catch((err) => {
      this.log.error(`${this.boiler.nickname}: ${label} failed: ${err.message}`);
      this.update();
    });
    return this._queue;
  }

  debounce(key, task, delayMs = DEBOUNCE_MS) {
    clearTimeout(this._debounce.get(key));
    this._debounce.set(
      key,
      setTimeout(() => {
        this._debounce.delete(key);
        task();
      }, delayMs),
    );
  }

  async send(mode, paramLiterals = []) {
    this.log.info(`${this.boiler.nickname}: ${mode}${paramLiterals.length ? ` [${paramLiterals}]` : ''}`);
    await this.cloud.control(this.boiler, mode, paramLiterals);
  }

  /** Resolve true once the boiler reports a state matching `predicate`, false on timeout. */
  waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      if (predicate()) {
        resolve(true);
        return;
      }
      const finish = (result) => {
        clearTimeout(timer);
        this.cloud.off('boiler-update', onUpdate);
        resolve(result);
      };
      const onUpdate = (boiler) => {
        if (boiler === this.boiler && predicate()) {
          finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.cloud.on('boiler-update', onUpdate);
    });
  }

  dispose() {
    for (const timer of this._debounce.values()) {
      clearTimeout(timer);
    }
    this._debounce.clear();
  }

  update() {}
}
