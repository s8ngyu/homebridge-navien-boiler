import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NavienApi,
  NavienAuthError,
  buildBoilerBody,
  extractMessageJson,
} from '../src/navien/api.js';
import { Boiler } from '../src/navien/boiler.js';
import { buildSignedWsPath } from '../src/navien/mqtt.js';
import { FEATURE, RAW, STATUS } from './fixtures.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test('boiler: features, ranges and steps', () => {
  const boiler = new Boiler(RAW);
  assert.equal(boiler.supports('inside'), false, 'nothing is supported before the feature list arrives');
  assert.equal(boiler.applyResponse({ feature: FEATURE }), true);
  assert.equal(boiler.applyResponse({ feature: FEATURE }), false, 'same feature list is not a change');
  assert.equal(boiler.nickname, '우리집 보일러');
  assert.equal(boiler.supports('inside'), true, 'Use 3 counts as supported');
  assert.deepEqual(boiler.range('ondol'), { min: 40, max: 83 });
  assert.equal(boiler.step('inside'), 1);
  assert.equal(boiler.encode('inside', 24), '24', 'Use 3 sends an integer');

  boiler.applyResponse({ feature: { insideUse: 2 } });
  assert.equal(boiler.step('inside'), 0.5);
  assert.equal(boiler.encode('inside', 23), '23.0', 'Use 2 sends a float, like the app');
  assert.equal(boiler.encode('inside', 22.5), '22.5');

  boiler.applyResponse({ feature: { ondolUse: 1, hotWaterTemperatureSettingUse: 4 } });
  assert.equal(boiler.supports('ondol'), false, 'Use 1 is unsupported');
  assert.equal(boiler.isLevel('hotWaterTemperatureSetting'), true);
});

test('boiler: partial status updates merge', () => {
  const boiler = new Boiler(RAW);
  assert.equal(boiler.hasStatus, false);
  boiler.applyResponse({ status: STATUS });
  boiler.applyResponse({ status: { operationMode: 1 } });
  assert.equal(boiler.isOn, false);
  assert.equal(boiler.value('insideTemperatureSetting'), 24, 'other values survive a partial update');
  assert.equal(boiler.modeName, '꺼짐');
});

test('request envelope matches the app for NR-35D / NR-40D', () => {
  const read = JSON.parse(buildBoilerBody(RAW, 'cid', ['status', 'res'], { now: 1700000000000 }));
  assert.deepEqual(read, {
    serviceCode: 100,
    payload: {
      sessionID: '1700000000000',
      clientID: 'mobile-cid',
      requestTopic: 'cmd/002/roomcon-A1B2C3D4E5F6/status',
      responseTopic: 'cmd/002/topickey-test/mobile-cid/res',
      request: { macAddress: 'A1B2C3D4E5F6', registerAt: '1700000000000', additionalValue: '0002', param: [] },
    },
  });

  const raw = buildBoilerBody(RAW, 'cid', ['control', 'res'], { mode: 'inside-heat', paramLiterals: ['23.0'] });
  assert.match(raw, /"mode":"inside-heat","param":\[23\.0\]/, 'float literal survives and mode precedes param');
  const control = JSON.parse(raw).payload;
  assert.equal(control.requestTopic, 'cmd/002/roomcon-A1B2C3D4E5F6/control');
  for (const key of ['command', 'deviceType', 'paramStr']) {
    assert.equal(key in control.request, false, `${key} is only for NR-6x`);
  }
  assert.equal('protocolVersion' in control, false);
  assert.throws(() => buildBoilerBody(RAW, 'cid', ['control', 'res'], { mode: 'x', paramLiterals: ['1]}'] }));
});

test('SigV4 presigned path matches an independent implementation', () => {
  const path = buildSignedWsPath(
    {
      accessKeyId: 'ASIAEXAMPLEKEY123456',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      sessionToken: 'IQoJb3JpZ2luX2Vj//////////wEaDmFwLW5vcnRoZWFzdC0yIkcw+RQIhAK/example==',
    },
    new Date(Date.UTC(2026, 10, 21, 3, 4, 5)),
  );
  assert.equal(
    path,
    '/mqtt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLEKEY123456%2F20261121%2Fap-northeast-2%2Fiotdevicegateway%2Faws4_request&X-Amz-Date=20261121T030405Z&X-Amz-SignedHeaders=host&X-Amz-Signature=ca42942ed48405b8212d6f43d84e4cf250d684bf2bf9659da7a4b3b7d1b47a91&X-Amz-Security-Token=IQoJb3JpZ2luX2Vj%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaDmFwLW5vcnRoZWFzdC0yIkcw%2BRQIhAK%2Fexample%3D%3D',
  );
});

// -- login flow against a fake server ---------------------------------------

function response(status, { headers = {}, cookies = [], body = '' } = {}) {
  const h = new Headers(headers);
  for (const cookie of cookies) {
    h.append('set-cookie', cookie);
  }
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers: h });
}

function fakeServer({ password = 'right', sessionDiesOnce = false } = {}) {
  const calls = [];
  let token = 0;
  let killed = !sessionDiesOnce;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method, path: url.pathname, headers: init.headers, body: init.body };
    calls.push(call);
    if (url.pathname === '/member/login' && init.method === 'POST') {
      const form = new URLSearchParams(init.body);
      if (form.get('password') !== password) {
        return response(200, {
          body: '<div id="loginFailPopup" style="display:none;">입력한 정보가 일치하지 않습니다. 현재 2회</div>',
        });
      }
      return response(302, { headers: { location: '/member/loginOk' }, cookies: ['JSESSIONID=abc; Path=/; HttpOnly'] });
    }
    if (url.pathname === '/member/loginOk') {
      assert.equal(init.headers.Cookie, 'JSESSIONID=abc', 'the session cookie follows the redirect');
      if (init.headers.Referer !== 'https://member.naviensmartcontrol.com/member/login') {
        return response(404, { body: '<title>오류</title>' }); // what the real server does
      }
      token += 1;
      const message = { accessToken: `tok${token}`, refreshToken: 'r', loginId: 'user', userSeq: 111 };
      return response(200, { body: `<script>\n  var message = ${JSON.stringify(message)};\n</script>` });
    }
    if (url.pathname.endsWith('/users/secured-sign-in')) {
      return response(200, {
        body: JSON.stringify({
          code: 200,
          data: {
            home: [{ homeSeq: 5 }],
            userInfo: { userSeq: 222 },
            authInfo: { accessKeyId: 'A', secretKey: 'S', sessionToken: 'T' },
          },
        }),
      });
    }
    if (url.pathname.endsWith('/devices')) {
      if (!killed) {
        killed = true;
        return response(200, { body: JSON.stringify({ code: 404, msg: 'taken over' }) });
      }
      assert.equal(url.searchParams.get('userSeq'), '222', 'userSeq comes from secured-sign-in');
      return response(200, { body: JSON.stringify({ code: 200, data: { devices: [RAW] } }) });
    }
    if (/\/devices\/77\/control$/.test(url.pathname)) {
      return response(200, { body: JSON.stringify({ code: 200 }) });
    }
    return response(500, { body: 'unexpected' });
  };
  return { calls, fetchImpl };
}

test('login follows the redirect with cookies and lists devices', async () => {
  const server = fakeServer();
  const api = new NavienApi({ username: 'user', password: 'right', log: quiet, fetchImpl: server.fetchImpl });
  const session = await api.login();
  assert.equal(session.accountSeq, 111);
  assert.equal(session.userSeq, 222);
  assert.deepEqual(session.aws, { accessKeyId: 'A', secretKey: 'S', sessionToken: 'T' });
  assert.deepEqual(await api.getDevices(5), [RAW]);
  const signIn = server.calls.find((c) => c.path.endsWith('secured-sign-in'));
  assert.equal(signIn.headers.Authorization, 'tok1');
  assert.deepEqual(JSON.parse(signIn.body), { userId: 'user', accountSeq: 111 });
});

test('a taken-over session logs in again once and retries', async () => {
  const server = fakeServer({ sessionDiesOnce: true });
  const api = new NavienApi({ username: 'user', password: 'right', log: quiet, fetchImpl: server.fetchImpl });
  await api.login();
  assert.deepEqual(await api.getDevices(5), [RAW]);
  assert.equal(server.calls.filter((c) => c.path === '/member/login').length, 2);
  assert.equal(server.calls.filter((c) => c.path.endsWith('/devices')).at(-1).headers.Authorization, 'tok2');
});

test('a wrong password is never retried (5 failures lock the account)', async () => {
  const server = fakeServer();
  const api = new NavienApi({ username: 'user', password: 'wrong', log: quiet, fetchImpl: server.fetchImpl });
  await assert.rejects(api.login(), (err) => err instanceof NavienAuthError && /attempt 2 of 5/.test(err.message));
  await assert.rejects(api.login(), NavienAuthError);
  await assert.rejects(api.getDevices(5), NavienAuthError);
  assert.equal(server.calls.filter((c) => c.path === '/member/login').length, 1, 'only one attempt reached the server');
});

test('token JSON is read from the login page', () => {
  assert.deepEqual(extractMessageJson('x\n var message = {"accessToken":"a","userSeq":1};\n'), {
    accessToken: 'a',
    userSeq: 1,
  });
  assert.equal(extractMessageJson('<html>nothing</html>'), null);
});

test('an unrecognised login page is described without values and never retried', async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push(String(input));
    return new Response('<html><title>Oops</title><form action="/member/login?x=1"><script>var secretThing = "s3cret";</script><div id="errorPopup"></div></html>', { status: 200 });
  };
  const api = new NavienApi({ username: 'user', password: 'pw', log: quiet, fetchImpl });
  await assert.rejects(api.login(), (err) => {
    assert.ok(err instanceof NavienAuthError);
    assert.match(err.message, /POST https:\/\/member\.naviensmartcontrol\.com\/member\/login -> 200/);
    assert.match(err.message, /title="Oops".*scriptVars=\[secretThing\].*forms=\[\/member\/login\].*ids=\[errorPopup\]/);
    assert.equal(err.message.includes('s3cret'), false);
    return true;
  });
  await assert.rejects(api.login(), NavienAuthError);
  assert.equal(calls.length, 1);
});

test('tokens are found even when the page formats them differently', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/member/login') {
      return new Response('<script>var message={"accessToken":"t","loginId":"user","userSeq":1};</script>', { status: 200 });
    }
    return new Response(JSON.stringify({ code: 200, data: { home: [{ homeSeq: 1 }], userInfo: { userSeq: 2 }, authInfo: {} } }));
  };
  const api = new NavienApi({ username: 'user', password: 'pw', log: quiet, fetchImpl });
  assert.equal((await api.login()).accessToken, 't');
});
