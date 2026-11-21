import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { NavienAuthError } from '../src/navien/api.js';
import { NavienCloud } from '../src/navien/cloud.js';
import { NavienMqtt } from '../src/navien/mqtt.js';
import { FEATURE, RAW, STATUS } from './fixtures.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function setup(t, { devices = [RAW], loginError } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const requests = [];
  const api = {
    logins: 0,
    async login() {
      this.logins += 1;
      if (loginError) {
        throw loginError;
      }
      return { userSeq: 222, homes: [{ homeSeq: 5 }, { homeSeq: 9 }] };
    },
    async getDevices(homeSeq) {
      assert.equal(homeSeq, 9);
      return devices;
    },
    async refreshAwsCredentials() {
      return { accessKeyId: 'A', secretKey: 'S', sessionToken: 'T' };
    },
    async boilerRequest(homeSeq, device, clientId, request, options = {}) {
      requests.push([request[0], options.mode, ...(options.paramLiterals ?? [])].filter((x) => x !== undefined));
      return '{}';
    },
  };
  const mqtt = Object.assign(new EventEmitter(), {
    clientId: 'uuid-U222',
    connected: false,
    start() {
      this.connected = true;
      this.emit('connected');
    },
    stop() {
      this.connected = false;
    },
  });
  const cloud = new NavienCloud({ homeSeq: 9, log: quiet, api, mqttFactory: () => mqtt });
  const message = (response, topic = 'cmd/002/topickey-test/mobile-uuid-U222/res') =>
    mqtt.emit('message', `9/smarttok/${RAW.deviceId}`, { topic, payload: { response } });
  return { api, cloud, mqtt, requests, message };
}

test('startup asks for features, then status, and builds the boiler from the replies', async (t) => {
  const { cloud, requests, message } = setup(t, {
    devices: [RAW, { serviceCode: 200, modelCode: '5', modelName: 'EME520' }, { ...RAW, deviceId: 'X', modelCode: '20' }],
  });
  const events = [];
  cloud.on('devices', (ids) => events.push(['devices', ids]));
  cloud.on('boiler-ready', (b) => events.push(['ready', b.deviceId]));
  cloud.on('boiler-update', (b) => events.push(['update', b.operationMode]));

  await cloud.start();
  await flush();
  assert.equal(cloud.homeSeq, 9, 'uses the configured home');
  assert.deepEqual(events, [['devices', [RAW.deviceId]]], 'mats and unsupported boiler models are skipped');
  assert.deepEqual(requests, [['status/start']]);

  message({ feature: FEATURE });
  t.mock.timers.tick(8000);
  await flush();
  assert.deepEqual(requests, [['status/start'], ['status']]);
  message({ status: STATUS });
  assert.deepEqual(events.slice(1), [['ready', RAW.deviceId], ['update', null], ['update', 5]]);

  const boiler = cloud.boilers.get(RAW.deviceId);
  assert.equal(boiler.value('hotWaterTemperatureSetting'), 42);
  cloud.stop();
});

test('after a command a silent boiler is asked for its status; a talkative one is not', async (t) => {
  const { cloud, requests, message } = setup(t);
  await cloud.start();
  message({ feature: FEATURE });
  t.mock.timers.tick(8000);
  await flush();
  message({ status: STATUS });
  const boiler = cloud.boilers.get(RAW.deviceId);
  requests.length = 0;

  await cloud.control(boiler, 'inside-heat', ['25']);
  t.mock.timers.tick(1000);
  message({ status: { insideTemperatureSetting: 25 } });
  t.mock.timers.tick(4000);
  await flush();
  assert.deepEqual(requests, [['control', 'inside-heat', '25']], 'the boiler reported by itself');

  await cloud.control(boiler, 'power-off');
  t.mock.timers.tick(4000);
  await flush();
  assert.deepEqual(requests.slice(1), [['control', 'power-off'], ['status']]);

  requests.length = 0;
  t.mock.timers.tick(16 * 60_000);
  await flush();
  assert.deepEqual(requests, [['status']], 'a boiler silent for 15 minutes is asked once');
  cloud.stop();
});

test('a rejected login is reported once and not retried', async (t) => {
  const { api, cloud } = setup(t, { loginError: new NavienAuthError('bad password') });
  await cloud.start();
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(api.logins, 1);
  assert.equal(cloud.mqtt, null);
});

test('mqtt reconnects with freshly signed credentials', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clients = [];
  let issued = 0;
  const connect = (url, options) => {
    const client = Object.assign(new EventEmitter(), {
      url,
      options,
      subscribe(topic, _opts, cb) {
        this.topic = topic;
        cb(null);
      },
      end() {},
    });
    clients.push(client);
    return client;
  };
  const mqtt = new NavienMqtt({
    homeSeq: 9,
    userSeq: 222,
    log: quiet,
    connect,
    getCredentials: async () => {
      issued += 1;
      return { accessKeyId: `KEY${issued}`, secretKey: 'S', sessionToken: 'T' };
    },
  });
  const seen = [];
  mqtt.on('message', (topic, body) => seen.push([topic, body]));
  mqtt.start();
  await flush();

  assert.match(clients[0].url, /^wss:\/\/nskr-iot\.naviensmartcontrol\.com\/mqtt\?.*Credential=KEY1%2F/);
  assert.match(clients[0].options.clientId, /^[0-9a-f-]{36}-U222$/);
  assert.equal(clients[0].options.reconnectPeriod, 0);
  clients[0].emit('connect');
  assert.equal(clients[0].topic, '9/smarttok/#');
  assert.equal(mqtt.connected, true);
  clients[0].emit('message', '9/smarttok/abc', Buffer.from('{"a":1}'));
  clients[0].emit('message', '9/smarttok/abc', Buffer.from('not json'));
  assert.deepEqual(seen, [['9/smarttok/abc', { a: 1 }]]);

  clients[0].emit('close');
  assert.equal(mqtt.connected, false);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(clients.length, 2);
  assert.match(clients[1].url, /Credential=KEY2%2F/, 'the second connection is signed with new credentials');
  mqtt.stop();
  clients[1].emit('close');
  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(clients.length, 2, 'no reconnect after stop');
});
