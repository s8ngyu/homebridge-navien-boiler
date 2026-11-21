import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { DEBOUNCE_MS, TAP_DEBOUNCE_MS } from '../src/accessories/base.js';
import { Boiler } from '../src/navien/boiler.js';
import { NavienBoilerPlatform, setCloudFactory } from '../src/platform.js';
import { FEATURE, RAW, STATUS } from './fixtures.js';

const require = createRequire(import.meta.url);
const { HomebridgeAPI } = require('homebridge/lib/api');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Stands in for the Navien cloud: records commands and lets the test play the boiler's replies. */
class FakeCloud extends EventEmitter {
  constructor() {
    super();
    this.boilers = new Map();
    this.commands = [];
    this.autoReply = true;
  }

  addCachedBoiler(raw, feature) {
    const boiler = new Boiler(raw);
    Object.assign(boiler.feature, feature ?? {});
    this.boilers.set(boiler.deviceId, boiler);
    return boiler;
  }

  start() {}
  stop() {}

  /** The boiler appears on the account and answers the two startup reads. */
  discover(raw = RAW, feature = FEATURE, status = STATUS) {
    const boiler = this.boilers.get(raw.deviceId) ?? new Boiler(raw);
    this.boilers.set(boiler.deviceId, boiler);
    this.emit('devices', [boiler.deviceId]);
    if (boiler.applyResponse({ feature })) {
      this.emit('boiler-ready', boiler);
    }
    this.report(boiler, status);
    return boiler;
  }

  report(boiler, status) {
    boiler.applyResponse({ status });
    this.emit('boiler-update', boiler);
  }

  async control(boiler, mode, paramLiterals = []) {
    this.commands.push([mode, ...paramLiterals]);
    if (!this.autoReply) {
      return;
    }
    // What the real boiler reports back after each command.
    const value = Number(paramLiterals[0]);
    const effect = {
      'power-on': { operationMode: this.modeBeforeOff ?? 5 },
      'power-off': { operationMode: 1 },
      'goout-on': { operationMode: 4 },
      'inside-heat': { operationMode: 5, insideTemperatureSetting: value },
      'ondol-heat': { operationMode: 6, ondolTemperatureSetting: value },
      'only-hotwater': { operationMode: 10 },
      'hotwater-temperature': { hotWaterTemperatureSetting: value },
    }[mode];
    if (mode === 'power-off') {
      this.modeBeforeOff = boiler.operationMode;
    }
    queueMicrotask(() => this.report(boiler, effect));
  }
}

function setup(t, config = {}, cached = []) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = new HomebridgeAPI();
  const registered = [];
  const unregistered = [];
  api.registerPlatformAccessories = (_plugin, _platform, list) => registered.push(...list);
  api.unregisterPlatformAccessories = (_plugin, _platform, list) => unregistered.push(...list);
  api.updatePlatformAccessories = () => {};

  const cloud = new FakeCloud();
  setCloudFactory(() => cloud);
  const platform = new NavienBoilerPlatform(quiet, { username: 'u', password: 'p', ...config }, api);
  for (const accessory of cached) {
    platform.configureAccessory(accessory);
  }
  api.emit('didFinishLaunching');

  const { Service, Characteristic } = api.hap;
  const find = (name) => [...platform.cached.values()].find((a) => a.displayName === name);
  const thermostat = (accessory, subtype) => accessory.getServiceById(Service.Thermostat, subtype);
  /** Let debounced writes fire and the command queue drain. */
  const settle = async (ms = DEBOUNCE_MS) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const set = (service, characteristic, value) => service.getCharacteristic(characteristic).handleSetRequest(value);
  const get = (service, characteristic) => service.getCharacteristic(characteristic).handleGetRequest();
  return { api, cloud, platform, registered, unregistered, Service, Characteristic, find, thermostat, settle, set, get };
}

test('creates a heating thermostat, an away switch and a hot water thermostat', async (t) => {
  const { cloud, registered, Service, Characteristic: C, find, thermostat, get } = setup(t);
  cloud.discover();

  assert.deepEqual(registered.map((a) => a.displayName), ['우리집 보일러', '우리집 보일러 온수']);
  const heating = find('우리집 보일러');
  const service = thermostat(heating, 'inside');
  assert.ok(service, 'auto picks 실내난방 when the boiler has it');
  assert.equal(thermostat(heating, 'ondol'), undefined);
  assert.ok(heating.getServiceById(Service.Switch, 'goout'));
  assert.equal(heating.getServiceById(Service.Switch, 'hotwater-only'), undefined, 'opt-in only');

  assert.equal(await get(service, C.CurrentHeatingCoolingState), 1);
  assert.equal(await get(service, C.CurrentTemperature), 25);
  assert.equal(await get(service, C.TargetTemperature), 24);
  const props = service.getCharacteristic(C.TargetTemperature).props;
  assert.deepEqual([props.minValue, props.maxValue, props.minStep], [10, 40, 1]);

  const water = thermostat(find('우리집 보일러 온수'), 'hotwater');
  assert.equal(await get(water, C.TargetTemperature), 42);
  const waterProps = water.getCharacteristic(C.TargetTemperature).props;
  assert.deepEqual([waterProps.minValue, waterProps.maxValue], [30, 60]);
  assert.deepEqual(water.getCharacteristic(C.TargetHeatingCoolingState).props.validValues, [1]);
});

test('temperature writes are debounced and sent as the app would', async (t) => {
  const { cloud, Characteristic: C, find, thermostat, settle, set, get } = setup(t);
  cloud.discover();
  const service = thermostat(find('우리집 보일러'), 'inside');

  await set(service, C.TargetTemperature, 22);
  await set(service, C.TargetTemperature, 23);
  assert.deepEqual(cloud.commands, [], 'nothing is sent while the slider is still moving');
  await settle();
  assert.deepEqual(cloud.commands, [['inside-heat', '23']]);
  assert.equal(await get(service, C.TargetTemperature), 23, 'shows what the boiler reported back');

  const water = thermostat(find('우리집 보일러 온수'), 'hotwater');
  await set(water, C.TargetTemperature, 45);
  await settle();
  assert.deepEqual(cloud.commands.at(-1), ['hotwater-temperature', '45']);
});

test('an off thermostat ignores temperature writes instead of turning the boiler on', async (t) => {
  const { cloud, Characteristic: C, find, thermostat, settle, set, get } = setup(t);
  const boiler = cloud.discover();
  cloud.report(boiler, { operationMode: 1 });
  const service = thermostat(find('우리집 보일러'), 'inside');
  assert.equal(await get(service, C.TargetHeatingCoolingState), 0);

  await set(service, C.TargetTemperature, 28);
  await settle();
  assert.deepEqual(cloud.commands, []);
  assert.equal(service.getCharacteristic(C.TargetTemperature).value, 24, 'the tile goes back to the real setpoint');
});

test('turning on powers the boiler on, then applies a temperature sent with it', async (t) => {
  const { cloud, Characteristic: C, find, thermostat, settle, set, get } = setup(t);
  const boiler = cloud.discover();
  cloud.report(boiler, { operationMode: 1 });
  const service = thermostat(find('우리집 보일러'), 'inside');

  // The Home app writes both characteristics in one go; order is not guaranteed.
  await set(service, C.TargetTemperature, 26);
  await set(service, C.TargetHeatingCoolingState, 1);
  await settle();
  assert.deepEqual(cloud.commands, [['power-on'], ['inside-heat', '26']]);
  assert.equal(await get(service, C.CurrentHeatingCoolingState), 1);

  await set(service, C.TargetHeatingCoolingState, 0);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands.at(-1), ['power-off']);
});

test('turning on from hot-water-only or away switches back to heating', async (t) => {
  const { cloud, Service, Characteristic: C, find, thermostat, settle, set, get } = setup(t);
  const boiler = cloud.discover();
  const heating = find('우리집 보일러');
  const away = heating.getServiceById(Service.Switch, 'goout');

  await set(away, C.On, true);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands, [['goout-on']]);
  assert.equal(await get(away, C.On), true);
  assert.equal(await get(thermostat(heating, 'inside'), C.CurrentHeatingCoolingState), 0, 'away shows as off');

  await set(away, C.On, false);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands.at(-1), ['inside-heat', '24'], 'returns with the stored setpoint');

  cloud.report(boiler, { operationMode: 10 });
  await set(thermostat(heating, 'inside'), C.TargetHeatingCoolingState, 1);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands.at(-1), ['inside-heat', '24']);
});

test('a boiler that does not confirm power-on still gets the heat command', async (t) => {
  const { cloud, Characteristic: C, find, thermostat, settle, set } = setup(t);
  const boiler = cloud.discover();
  cloud.report(boiler, { operationMode: 1 });
  cloud.autoReply = false;
  await set(thermostat(find('우리집 보일러'), 'inside'), C.TargetHeatingCoolingState, 1);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands, [['power-on']]);
  await settle(6000);
  assert.deepEqual(cloud.commands, [['power-on'], ['inside-heat', '24']]);
});

test('heatingMode both: two thermostats that each stand for one mode', async (t) => {
  const { cloud, Service, Characteristic: C, find, thermostat, settle, set, get } = setup(t, {
    heatingMode: 'both',
    hotWaterOnlySwitch: true,
  });
  const boiler = cloud.discover();
  const heating = find('우리집 보일러');
  const inside = thermostat(heating, 'inside');
  const ondol = thermostat(heating, 'ondol');
  assert.equal(await get(inside, C.CurrentHeatingCoolingState), 1);
  assert.equal(await get(ondol, C.CurrentHeatingCoolingState), 0);
  const props = ondol.getCharacteristic(C.TargetTemperature).props;
  assert.deepEqual([props.minValue, props.maxValue], [40, 83]);
  assert.equal(await get(ondol, C.TargetTemperature), 45);

  await set(ondol, C.TargetHeatingCoolingState, 0);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands, [], 'switching the idle thermostat off must not stop the active one');

  await set(ondol, C.TargetHeatingCoolingState, 1);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands, [['ondol-heat', '45']]);
  assert.equal(await get(inside, C.CurrentHeatingCoolingState), 0);

  const hotWaterOnly = heating.getServiceById(Service.Switch, 'hotwater-only');
  await set(hotWaterOnly, C.On, true);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands.at(-1), ['only-hotwater', '42']);
  await set(hotWaterOnly, C.On, false);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands.at(-1), ['ondol-heat', '45'], 'returns to the mode that was last heating');
  assert.equal(boiler.operationMode, 6);
});

test('half-degree boilers and level-type hot water', async (t) => {
  const { cloud, registered, Characteristic: C, find, thermostat, settle, set } = setup(t);
  cloud.discover(RAW, {
    ...FEATURE,
    insideUse: 2,
    hotWaterTemperatureSettingUse: 4,
    hotWaterTemperatureMin: 1,
    hotWaterTemperatureMax: 3,
  }, { ...STATUS, insideTemperatureSetting: 22.5, hotWaterTemperatureSetting: 3 });
  assert.deepEqual(registered.map((a) => a.displayName), ['우리집 보일러'], 'no °C thermostat for 1-3 level hot water');
  const service = thermostat(find('우리집 보일러'), 'inside');
  assert.equal(service.getCharacteristic(C.TargetTemperature).props.minStep, 0.5);
  await set(service, C.TargetTemperature, 23);
  await settle();
  assert.deepEqual(cloud.commands, [['inside-heat', '23.0']]);
});

test('accessories are restored from the cache and report No Response until the boiler answers', async (t) => {
  const first = setup(t);
  first.cloud.discover();
  const cached = [...first.platform.cached.values()];
  t.mock.timers.reset();

  const { cloud, registered, unregistered, Characteristic: C, find, thermostat, get } = setup(t, {}, cached);
  const service = thermostat(find('우리집 보일러'), 'inside');
  assert.ok(service, 'services exist before the cloud has answered');
  await assert.rejects(get(service, C.CurrentTemperature), (err) => err === -70402);

  cloud.discover();
  assert.deepEqual(registered, [], 'nothing is registered twice');
  assert.deepEqual(unregistered, []);
  assert.equal(await get(service, C.CurrentTemperature), 25);

  cloud.emit('devices', []);
  assert.equal(unregistered.length, 2, 'a boiler removed from the account is removed from HomeKit');
});

test('one tap delivered as several identical writes sends one command', async (t) => {
  const { cloud, Service, Characteristic: C, find, thermostat, settle, set } = setup(t);
  cloud.discover();
  const heating = find('우리집 보일러');
  const away = heating.getServiceById(Service.Switch, 'goout');
  await set(away, C.On, true);
  await set(away, C.On, true);
  await set(away, C.On, true);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands, [['goout-on']]);

  await set(away, C.On, false);
  await set(away, C.On, false);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands, [['goout-on'], ['inside-heat', '24']]);

  const service = thermostat(heating, 'inside');
  await set(service, C.TargetHeatingCoolingState, 0);
  await set(service, C.TargetHeatingCoolingState, 0);
  await settle(TAP_DEBOUNCE_MS);
  assert.deepEqual(cloud.commands.at(-1), ['power-off']);
  assert.equal(cloud.commands.length, 3);
});
