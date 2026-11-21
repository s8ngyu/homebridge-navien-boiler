import { MODE_NAMES, MODE_OFF } from './const.js';

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One boiler room controller: the raw entry from the device list plus the
 * feature list and status received over MQTT.
 *
 * For NR-35D / NR-40D (modelCode 002 / 003) temperatures are plain °C.
 * `{name}Use` in the feature list: 1 = unsupported, 2 = 0.5°C steps (sent as a
 * float), 3 = 1°C steps (sent as an integer), 4 = level (1-3) instead of °C.
 */
export class Boiler {
  constructor(raw) {
    this.raw = raw;
    this.feature = {};
    this.status = {};
    this.lastMessageAt = 0;
  }

  get deviceId() {
    return String(this.raw.deviceId);
  }

  get modelCode() {
    return String(this.raw.modelCode ?? '');
  }

  get modelName() {
    return String(this.raw.modelName || 'Navien Boiler');
  }

  get nickname() {
    let name = this.raw.Properties?.nickName;
    if (name && typeof name === 'object') {
      name = name.mainItem;
    }
    return String(name || this.modelName);
  }

  get hasFeature() {
    return Object.keys(this.feature).length > 0;
  }

  get hasStatus() {
    return this.operationMode !== null;
  }

  // -- feature -------------------------------------------------------------

  use(name) {
    return num(this.feature[`${name}Use`]);
  }

  supports(name) {
    const use = this.use(name);
    return use !== null && use !== 1;
  }

  isLevel(name) {
    return this.use(name) === 4;
  }

  step(name) {
    return this.use(name) === 2 ? 0.5 : 1;
  }

  /** Setting range in °C for `inside`, `ondol` or `hotWater`. */
  range(name) {
    const min = num(this.feature[`${name}TemperatureMin`]);
    const max = num(this.feature[`${name}TemperatureMax`]);
    if (min === null || max === null || min >= max) {
      return null;
    }
    return { min, max };
  }

  /**
   * The JSON literal to put in `param` for a temperature. The app sends a float
   * for 0.5°C controls ("23.0") and an integer otherwise ("23"); keep that shape.
   */
  encode(name, celsius) {
    if (this.use(name) === 2) {
      return (Math.round(celsius * 2) / 2).toFixed(1);
    }
    return String(Math.round(celsius));
  }

  // -- status --------------------------------------------------------------

  get operationMode() {
    return num(this.status.operationMode);
  }

  get isOn() {
    const mode = this.operationMode;
    return mode === null ? null : mode !== MODE_OFF;
  }

  get modeName() {
    const mode = this.operationMode;
    return mode === null ? 'unknown' : (MODE_NAMES[mode] ?? `unknown(${mode})`);
  }

  value(key) {
    return num(this.status[key]);
  }

  /**
   * Merge one `payload.response`. Partial updates must not wipe known values.
   * Returns true when the feature list changed (services may need rebuilding).
   */
  applyResponse(response) {
    let featureChanged = false;
    const { feature, status } = response ?? {};
    if (feature && typeof feature === 'object' && !Array.isArray(feature)) {
      const before = JSON.stringify(this.feature);
      Object.assign(this.feature, feature);
      featureChanged = JSON.stringify(this.feature) !== before;
      this.lastMessageAt = Date.now();
    }
    if (status && typeof status === 'object' && !Array.isArray(status)) {
      Object.assign(this.status, status);
      this.lastMessageAt = Date.now();
    }
    return featureChanged;
  }
}
