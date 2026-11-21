import {
  API_URL,
  CODE_NOT_AUTHORIZED,
  CODE_SUCCESS,
  CODE_TOKEN_EXPIRED,
  LOGIN_URL,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
} from './const.js';

export class NavienError extends Error {}

/** Wrong credentials or an account state only the user can fix. Never retried automatically. */
export class NavienAuthError extends NavienError {}

export class NavienApiError extends NavienError {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const FAIL_POPUP = 'id="loginFailPopup" style="display:none;"';
const MISMATCH = '입력한 정보가 일치하지 않습니다.';
const MESSAGE_MARKER = 'var message = ';
const PARAM_PLACEHOLDER = '\u0000PARAM\u0000';

/** The login page embeds the tokens as `var message = {...}`. */
export function extractMessageJson(html) {
  for (const line of html.split('\n')) {
    if (!line.includes(MESSAGE_MARKER)) {
      continue;
    }
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start === -1 || end <= start) {
      continue;
    }
    try {
      return JSON.parse(line.slice(start, end + 1));
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Fallback: any flat JSON object on the page that carries an accessToken. */
function extractTokenObject(html) {
  const match = html.match(/\{[^{}]*"accessToken"\s*:[^{}]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Describe an unexpected login page by its structure only. Never include values: they may be secrets. */
export function describePage(html) {
  const title = (html.match(/<title[^>]*>([^<]{0,80})/i)?.[1] ?? '').trim();
  const vars = [...new Set([...html.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]))];
  const forms = [...html.matchAll(/<form[^>]*\baction\s*=\s*["']?([^"'\s>?]*)/gi)].map((m) => m[1]);
  const ids = [...html.matchAll(/\bid\s*=\s*["']([\w-]*(?:[Pp]opup|[Ee]rror|[Ff]ail|[Cc]aptcha|[Aa]lert)[\w-]*)["']/g)].map((m) => m[1]);
  return (
    `title="${title}" length=${html.length} scriptVars=[${vars.slice(0, 25)}] forms=[${forms.slice(0, 5)}] ` +
    `ids=[${[...new Set(ids)].slice(0, 15)}]`
  );
}

export function authErrorFromHtml(html) {
  if (!html.includes(MISMATCH)) {
    return new NavienAuthError('Navien Smart username is incorrect.');
  }
  const match = html.match(/현재 (\d)회/);
  if (match) {
    return new NavienAuthError(
      `Navien Smart password is incorrect (failed attempt ${match[1]} of 5; after 5 the password must be reset).`,
    );
  }
  return new NavienAuthError('Navien Smart password is incorrect. A password reset may be required.');
}

/**
 * Build the body of a boiler request the way the app does for NR-35D / NR-40D
 * (`RequestControlNR35D`). `deviceId` is the 12-character MAC followed by a
 * 4-character additional value. `paramLiterals` are JSON number literals so
 * that "23.0" stays a float on the wire.
 */
export function buildBoilerBody(device, clientId, [requestName, responseName], options = {}) {
  const { mode, paramLiterals = [], now = Date.now() } = options;
  for (const literal of paramLiterals) {
    if (!/^-?\d+(\.\d+)?$/.test(literal)) {
      throw new NavienError(`Invalid boiler parameter: ${literal}`);
    }
  }
  const code = String(device.modelCode);
  const id = String(device.deviceId);
  const mac = id.slice(0, 12);
  const stamp = String(now);

  const request = { macAddress: mac, registerAt: stamp, additionalValue: id.slice(12, 16) };
  if (mode !== undefined && mode !== null) {
    request.mode = mode;
  }
  request.param = PARAM_PLACEHOLDER;

  const body = {
    serviceCode: device.serviceCode,
    payload: {
      sessionID: stamp,
      clientID: `mobile-${clientId}`,
      requestTopic: `cmd/${code}/roomcon-${mac}/${requestName}`,
      responseTopic: `cmd/${code}/${device.mqttTopicKey}/mobile-${clientId}/${responseName}`,
      request,
    },
  };
  return JSON.stringify(body).replace(JSON.stringify(PARAM_PLACEHOLDER), `[${paramLiterals.join(',')}]`);
}

export class NavienApi {
  constructor({ username, password, log, fetchImpl }) {
    this.username = username;
    this.password = password;
    this.log = log;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.session = null;
    this._loginPromise = null;
    this._authBlocked = null;
  }

  // -- auth ----------------------------------------------------------------

  /** Form login followed by secured-sign-in. Concurrent callers share one attempt. */
  login() {
    if (!this._loginPromise) {
      this._loginPromise = this._login().finally(() => {
        this._loginPromise = null;
      });
    }
    return this._loginPromise;
  }

  async _login() {
    if (this._authBlocked) {
      // A wrong password locks the account after 5 attempts, so never retry on our own.
      throw new NavienAuthError(this._authBlocked);
    }
    let login;
    try {
      login = await this._formLogin();
    } catch (err) {
      if (err instanceof NavienAuthError) {
        this._authBlocked = `${err.message} Fix the plugin settings and restart Homebridge.`;
      }
      throw err;
    }
    const data = await this._securedSignIn(login.accessToken, login.loginId, login.userSeq);
    const homes = Array.isArray(data.home) ? data.home : [];
    if (homes.length === 0) {
      throw new NavienError('No home is registered on this Navien Smart account.');
    }
    this.session = {
      accessToken: login.accessToken,
      userId: login.loginId,
      accountSeq: login.userSeq, // not the same number as userInfo.userSeq
      userSeq: data.userInfo?.userSeq,
      homes,
      aws: awsFrom(data.authInfo),
      awsAt: Date.now(),
    };
    this.log.debug(`Logged in to Navien Smart (${homes.length} home(s)).`);
    return this.session;
  }

  /** POST the login form and follow the redirects by hand, carrying the session cookies. */
  async _formLogin() {
    const cookies = new Map();
    const loginHost = new URL(LOGIN_URL).host;
    let url = `${LOGIN_URL}/member/login`;
    let method = 'POST';
    let html = null;
    const trace = [];

    for (let hop = 0; hop < 10; hop += 1) {
      const sameHost = new URL(url).host === loginHost;
      const headers = { 'User-Agent': USER_AGENT };
      if (sameHost) {
        // The redirect target (/member/loginOk) answers 404 without the Referer, so keep
        // these on every hop, as a browser or the app's web view would.
        headers.Origin = LOGIN_URL;
        headers.Referer = `${LOGIN_URL}/member/login`;
        if (cookies.size > 0) {
          headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
        }
      }
      const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
      if (method === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams({ username: this.username, password: this.password }).toString();
      }

      let res;
      try {
        res = await this.fetch(url, init);
      } catch (err) {
        throw new NavienError(`Login request failed: ${err.message}`);
      }
      if (sameHost) {
        for (const cookie of res.headers.getSetCookie?.() ?? []) {
          const pair = cookie.split(';', 1)[0];
          const eq = pair.indexOf('=');
          if (eq > 0) {
            cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
          }
        }
      }
      const hopUrl = new URL(url);
      trace.push(`${method} ${hopUrl.protocol}//${hopUrl.host}${hopUrl.pathname} -> ${res.status}`);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
        }
        continue;
      }
      html = await res.text();
      break;
    }

    if (html === null) {
      throw new NavienError('Login redirected too many times.');
    }
    if (html.includes(FAIL_POPUP)) {
      throw authErrorFromHtml(html);
    }
    if (html.includes('passwordChg')) {
      throw new NavienAuthError(
        'Navien asks for a password change. Open the 나비엔 스마트 app or website and handle that first.',
      );
    }
    const tokens = extractMessageJson(html) ?? extractTokenObject(html);
    if (!tokens?.accessToken) {
      // Unknown outcome. Treat it like a rejected login: repeating it blindly could lock the account.
      throw new NavienAuthError(
        `Login did not return tokens. Requests: ${trace.join(', ')}. Cookies: [${[...cookies.keys()]}]. ` +
          `Page: ${describePage(html)}.`,
      );
    }
    return tokens;
  }

  async _securedSignIn(accessToken, userId, accountSeq) {
    const payload = await this._request('POST', '/users/secured-sign-in', {
      token: accessToken,
      rawBody: JSON.stringify({ userId, accountSeq }),
    });
    if (!payload.data) {
      throw new NavienError('secured-sign-in returned no data.');
    }
    return payload.data;
  }

  /**
   * Fresh temporary AWS IoT credentials for the MQTT connection.
   * Only secured-sign-in hands these out; the token refresh endpoint does not.
   */
  async refreshAwsCredentials() {
    if (!this.session) {
      return (await this.login()).aws;
    }
    if (this.session.aws && Date.now() - this.session.awsAt < 60_000) {
      return this.session.aws; // just issued by login
    }
    try {
      const { accessToken, userId, accountSeq } = this.session;
      const data = await this._securedSignIn(accessToken, userId, accountSeq);
      this.session.aws = awsFrom(data.authInfo);
      this.session.awsAt = Date.now();
      return this.session.aws;
    } catch (err) {
      if (!isSessionInvalid(err)) {
        throw err;
      }
      return (await this.login()).aws;
    }
  }

  // -- requests ------------------------------------------------------------

  async _request(method, path, { token, query, rawBody } = {}) {
    const url = new URL(`${API_URL}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const headers = { Authorization: token, 'User-Agent': USER_AGENT };
    if (rawBody !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let res;
    let text;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      throw new NavienError(`${path} request failed: ${err.message}`);
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // handled below
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      if (res.status === 401) {
        throw new NavienApiError(CODE_NOT_AUTHORIZED, `${path}: HTTP 401`);
      }
      throw new NavienError(`${path}: unexpected response (HTTP ${res.status}).`);
    }
    if (payload.code === CODE_SUCCESS) {
      return payload;
    }
    const code = res.status === 401 ? CODE_NOT_AUTHORIZED : payload.code;
    throw new NavienApiError(code, payload.msg || `${path} failed (code=${payload.code})`);
  }

  /**
   * The account has a single session: when the user opens the app our token dies.
   * Log in again once and retry.
   */
  async _authed(method, path, options = {}) {
    const session = this.session ?? (await this.login());
    try {
      return await this._request(method, path, { ...options, token: session.accessToken });
    } catch (err) {
      if (!isSessionInvalid(err)) {
        throw err;
      }
      this.log.debug(`Navien session is no longer valid (code=${err.code}); logging in again.`);
      const fresh = await this.login();
      return this._request(method, path, { ...options, token: fresh.accessToken });
    }
  }

  async getDevices(homeSeq) {
    const session = this.session ?? (await this.login());
    const payload = await this._authed('GET', '/devices', {
      query: { homeSeq, userSeq: session.userSeq },
    });
    return payload.data?.devices ?? [];
  }

  /** Relay one boiler request. Reads have no `mode`; control carries `mode` and `param`. */
  async boilerRequest(homeSeq, device, clientId, request, options = {}) {
    const session = this.session ?? (await this.login());
    const rawBody = buildBoilerBody(device, clientId, request, options);
    await this._authed('POST', `/devices/${device.deviceSeq}/control`, {
      query: { homeSeq, userSeq: session.userSeq },
      rawBody,
    });
    return rawBody;
  }
}

function awsFrom(info) {
  if (!info?.accessKeyId || !info?.secretKey || !info?.sessionToken) {
    return null;
  }
  return { accessKeyId: info.accessKeyId, secretKey: info.secretKey, sessionToken: info.sessionToken };
}

function isSessionInvalid(err) {
  return err instanceof NavienApiError && (err.code === CODE_NOT_AUTHORIZED || err.code === CODE_TOKEN_EXPIRED);
}
