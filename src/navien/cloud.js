import { EventEmitter } from 'node:events';

import { NavienApi, NavienAuthError } from './api.js';
import { Boiler } from './boiler.js';
import {
  READBACK_MS,
  RECONNECT_DELAYS_S,
  REQ_CONTROL,
  REQ_START,
  REQ_STATUS,
  SERVICE_BOILER,
  STALE_MS,
  STATUS_DELAY_MS,
  SUPPORTED_MODELS,
} from './const.js';
import { NavienMqtt } from './mqtt.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ties the REST client, the MQTT subscription and the boiler models together.
 *
 * Events:
 *  - `devices` (deviceIds[])  the device list was fetched
 *  - `boiler-ready` (boiler)  the feature list is known or changed
 *  - `boiler-update` (boiler) feature or status changed
 */
export class NavienCloud extends EventEmitter {
  constructor({ username, password, homeSeq, log, debug = false, api, mqttFactory }) {
    super();
    this.log = log;
    this.debug = debug;
    this.wantedHomeSeq = homeSeq;
    this.homeSeq = null;
    this.api = api ?? new NavienApi({ username, password, log });
    this._mqttFactory = mqttFactory ?? ((options) => new NavienMqtt(options));
    this.mqtt = null;
    this.boilers = new Map();
    this._askedAt = new Map();
    this._readback = new Map();
    this._ticker = null;
    this._stopping = false;
  }

  /** Seed a boiler from the Homebridge accessory cache so services exist before the cloud answers. */
  addCachedBoiler(raw, feature) {
    const boiler = new Boiler(raw);
    Object.assign(boiler.feature, feature ?? {});
    this.boilers.set(boiler.deviceId, boiler);
    return boiler;
  }

  async start() {
    this._stopping = false;
    for (let attempt = 0; !this._stopping; attempt += 1) {
      try {
        await this._connect();
        return;
      } catch (err) {
        if (err instanceof NavienAuthError) {
          this.log.error(`Navien login failed: ${err.message}`);
          return;
        }
        const delay = RECONNECT_DELAYS_S[Math.min(attempt, RECONNECT_DELAYS_S.length - 1)];
        this.log.warn(`Could not reach Navien Smart (${err.message}); retrying in ${delay}s.`);
        await sleep(delay * 1000);
      }
    }
  }

  stop() {
    this._stopping = true;
    clearInterval(this._ticker);
    for (const timer of this._readback.values()) {
      clearTimeout(timer);
    }
    this._readback.clear();
    this.mqtt?.stop();
  }

  async _connect() {
    // A retry after a network error must not log in again: every login ends the app's session.
    const session = this.api.session ?? (await this.api.login());
    const homes = session.homes;
    const home = homes.find((h) => h.homeSeq === this.wantedHomeSeq) ?? homes[0];
    if (homes.length > 1) {
      const list = homes.map((h) => h.homeSeq).join(', ');
      this.log.info(`Account has ${homes.length} homes (homeSeq: ${list}); using ${home.homeSeq}.`);
    }
    this.homeSeq = home.homeSeq;

    await this.refreshDevices();

    this.mqtt = this._mqttFactory({
      homeSeq: this.homeSeq,
      userSeq: session.userSeq,
      getCredentials: () => this.api.refreshAwsCredentials(),
      log: this.log,
    });
    this.mqtt.on('connected', () => {
      this.log.info('Connected to Navien Smart; listening for boiler updates.');
      this._probe().catch((err) => this.log.warn(`Boiler status request failed: ${err.message}`));
    });
    this.mqtt.on('disconnected', () => this.log.debug('Navien MQTT connection lost.'));
    this.mqtt.on('credentials-error', (err) => {
      if (err instanceof NavienAuthError) {
        this.log.error(`Navien login failed: ${err.message}`);
        this.mqtt.stop();
      }
    });
    this.mqtt.on('message', (topic, body) => this._onMessage(topic, body));
    this.mqtt.start();

    this._ticker = setInterval(() => this._askQuietBoilers(), 60_000);
    this._ticker.unref?.();
  }

  async refreshDevices() {
    const devices = await this.api.getDevices(this.homeSeq);
    const found = [];
    for (const raw of devices) {
      const label = `${raw.modelName ?? '?'} (serviceCode ${raw.serviceCode}, modelCode ${raw.modelCode})`;
      if (raw.serviceCode !== SERVICE_BOILER) {
        this.log.debug(`Skipping ${label}: not a boiler.`);
        continue;
      }
      if (!(String(raw.modelCode) in SUPPORTED_MODELS)) {
        this.log.warn(`Skipping boiler ${label}: this model code is not supported yet.`);
        continue;
      }
      const id = String(raw.deviceId);
      const existing = this.boilers.get(id);
      if (existing) {
        existing.raw = raw;
      } else {
        this.boilers.set(id, new Boiler(raw));
        this.log.info(`Found boiler ${label}.`);
      }
      found.push(id);
    }
    for (const id of [...this.boilers.keys()]) {
      if (!found.includes(id)) {
        this.boilers.delete(id); // was restored from the cache but is no longer on the account
      }
    }
    if (found.length === 0) {
      this.log.warn(`No supported boiler found among ${devices.length} device(s) in this home.`);
    }
    this.emit('devices', found);
    return found;
  }

  get clientId() {
    return this.mqtt?.clientId ?? '';
  }

  _request(boiler, request, options) {
    return this.api.boilerRequest(this.homeSeq, boiler.raw, this.clientId, request, options);
  }

  /** The same two reads the app sends when it opens the boiler screen. */
  async _probe() {
    const boilers = [...this.boilers.values()].filter((b) => b.raw.deviceSeq !== undefined);
    for (const boiler of boilers) {
      this._askedAt.set(boiler.deviceId, Date.now());
      await this._request(boiler, REQ_START);
    }
    await sleep(STATUS_DELAY_MS);
    for (const boiler of boilers) {
      await this._request(boiler, REQ_STATUS);
    }
  }

  async requestStatus(boiler) {
    this._askedAt.set(boiler.deviceId, Date.now());
    if (!boiler.hasFeature) {
      await this._request(boiler, REQ_START);
      await sleep(STATUS_DELAY_MS);
    }
    await this._request(boiler, REQ_STATUS);
  }

  /** Boilers report changes by themselves, so only ask the ones that have been silent. */
  _askQuietBoilers() {
    if (!this.mqtt?.connected) {
      return;
    }
    const now = Date.now();
    for (const boiler of this.boilers.values()) {
      if (boiler.raw.deviceSeq === undefined) {
        continue;
      }
      const last = Math.max(boiler.lastMessageAt, this._askedAt.get(boiler.deviceId) ?? 0);
      if (now - last < STALE_MS) {
        continue;
      }
      this.requestStatus(boiler).catch((err) =>
        this.log.debug(`Status request for ${boiler.modelName} failed: ${err.message}`),
      );
    }
  }

  /** Send one command. The result comes back as a status message from the boiler. */
  async control(boiler, mode, paramLiterals = []) {
    const sentAt = Date.now();
    const body = await this._request(boiler, REQ_CONTROL, { mode, paramLiterals });
    if (this.debug) {
      this.log.info(`[debug] sent ${body}`);
    }
    clearTimeout(this._readback.get(boiler.deviceId));
    const timer = setTimeout(() => {
      this._readback.delete(boiler.deviceId);
      if (boiler.lastMessageAt < sentAt) {
        this.requestStatus(boiler).catch((err) =>
          this.log.debug(`Status read-back for ${boiler.modelName} failed: ${err.message}`),
        );
      }
    }, READBACK_MS);
    timer.unref?.();
    this._readback.set(boiler.deviceId, timer);
  }

  /** Message envelope: `{ topic, payload: { response: { feature?, status? } } }`. */
  _onMessage(topic, body) {
    if (this.debug) {
      this.log.info(`[debug] ${topic} ${JSON.stringify(body)}`);
    }
    const boiler = [...this.boilers.values()].find((b) => topic.includes(b.deviceId));
    if (!boiler || !body || typeof body !== 'object') {
      return;
    }
    if (String(body.topic ?? '').endsWith('controlfail')) {
      this.log.warn(`${boiler.modelName} rejected the command (controlfail).`);
    }
    const response = body.payload?.response;
    if (!response || typeof response !== 'object') {
      return;
    }
    const hadStatus = boiler.hasStatus;
    const featureChanged = boiler.applyResponse(response);
    if (featureChanged) {
      this.log.info(`${boiler.modelName} features: ${JSON.stringify(boiler.feature)}`);
      this.emit('boiler-ready', boiler);
    }
    if (!hadStatus && boiler.hasStatus) {
      this.log.info(`${boiler.modelName} status: ${JSON.stringify(boiler.status)}`);
    }
    this.emit('boiler-update', boiler);
  }
}
