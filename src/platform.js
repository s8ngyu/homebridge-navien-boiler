import { HeatingAccessory } from './accessories/heating.js';
import { HotWaterAccessory } from './accessories/hotwater.js';
import { NavienCloud } from './navien/cloud.js';

export const PLUGIN_NAME = 'homebridge-navien-boiler';
export const PLATFORM_NAME = 'NavienBoiler';

const ACCESSORY_TYPES = [
  { key: 'heating', suffix: '', Handler: HeatingAccessory },
  { key: 'hotwater', suffix: ' 온수', Handler: HotWaterAccessory },
];

let cloudFactory = (options) => new NavienCloud(options);

/** Test hook: replace the cloud connection with a fake. */
export function setCloudFactory(factory) {
  cloudFactory = factory;
}

export class NavienBoilerPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;
    this.cloud = null;
    this.cached = new Map(); // UUID -> PlatformAccessory
    this.handlers = new Map(); // UUID -> accessory handler

    if (!this.config.username || !this.config.password) {
      log.error('Navien Smart username and password are not set; the plugin is idle.');
      return;
    }
    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
  }

  /** Homebridge hands back accessories it remembered from the last run. */
  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  start() {
    this.cloud = cloudFactory({
      username: this.config.username,
      password: this.config.password,
      homeSeq: this.config.homeSeq,
      debug: this.config.debug === true,
      log: this.log,
    });
    this.cloud.on('devices', (deviceIds) => this.prune(deviceIds));
    this.cloud.on('boiler-ready', (boiler) => this.setupBoiler(boiler));
    this.cloud.on('boiler-update', (boiler) => this.updateBoiler(boiler));

    // Rebuild from the cache right away so the Home app keeps its tiles while the cloud connects.
    const seeded = new Map();
    for (const accessory of this.cached.values()) {
      const { raw, feature } = accessory.context ?? {};
      if (raw?.deviceId && !seeded.has(raw.deviceId)) {
        seeded.set(raw.deviceId, this.cloud.addCachedBoiler(raw, feature));
      }
    }
    for (const boiler of seeded.values()) {
      if (boiler.hasFeature) {
        this.setupBoiler(boiler);
      }
    }

    Promise.resolve(this.cloud.start()).catch((err) => this.log.error(`Navien cloud failed: ${err.message}`));
  }

  stop() {
    for (const handler of this.handlers.values()) {
      handler.dispose();
    }
    this.cloud?.stop();
  }

  uuid(boiler, key) {
    return this.api.hap.uuid.generate(`${PLUGIN_NAME}:${boiler.deviceId}:${key}`);
  }

  /** Create or refresh the accessories of one boiler once its feature list is known. */
  setupBoiler(boiler) {
    for (const { key, suffix, Handler } of ACCESSORY_TYPES) {
      const uuid = this.uuid(boiler, key);
      if (!Handler.isSupported(boiler, this.config)) {
        this.remove(uuid);
        continue;
      }
      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      if (isNew) {
        accessory = new this.api.platformAccessory(`${boiler.nickname}${suffix}`, uuid);
      }
      Object.assign(accessory.context, { raw: boiler.raw, feature: boiler.feature });

      const handler = this.handlers.get(uuid);
      if (handler) {
        handler.boiler = boiler;
        handler.configure();
      } else {
        this.handlers.set(uuid, new Handler(this, accessory, boiler));
      }

      if (isNew) {
        this.cached.set(uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added ${accessory.displayName} to HomeKit.`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }
  }

  updateBoiler(boiler) {
    for (const { key } of ACCESSORY_TYPES) {
      this.handlers.get(this.uuid(boiler, key))?.update();
    }
  }

  remove(uuid) {
    this.handlers.get(uuid)?.dispose();
    this.handlers.delete(uuid);
    const accessory = this.cached.get(uuid);
    if (accessory) {
      this.cached.delete(uuid);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Removed ${accessory.displayName} from HomeKit.`);
    }
  }

  /** Drop accessories whose boiler is no longer on the account. Runs only after a successful device list. */
  prune(deviceIds) {
    for (const [uuid, accessory] of [...this.cached]) {
      const deviceId = accessory.context?.raw?.deviceId;
      if (!deviceId || !deviceIds.includes(String(deviceId))) {
        this.remove(uuid);
      }
    }
  }
}
