import { createHash, createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import mqtt from 'mqtt';

import { IOT_ENDPOINT, IOT_REGION, IOT_SERVICE, RECONNECT_DELAYS_S } from './const.js';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding: SigV4 needs '/' as %2F and leaves only unreserved characters. */
function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * SigV4 presigned path for AWS IoT MQTT over WebSocket.
 * The security token is appended after signing; that is an AWS IoT rule.
 */
export function buildSignedWsPath(creds, now = new Date(), region = IOT_REGION, host = IOT_ENDPOINT) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${IOT_SERVICE}/aws4_request`;

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(query[key])}`)
    .join('&');
  const canonicalRequest = ['GET', '/mqtt', canonicalQuery, `host:${host}\n`, 'host', sha256('')].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  let key = `AWS4${creds.secretKey}`;
  for (const part of [dateStamp, region, IOT_SERVICE, 'aws4_request']) {
    key = hmac(key, part);
  }
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');

  return (
    `/mqtt?${canonicalQuery}&X-Amz-Signature=${signature}` +
    `&X-Amz-Security-Token=${uriEncode(creds.sessionToken)}`
  );
}

/**
 * Subscribe-only MQTT client (commands go through REST). The temporary AWS
 * credentials expire, so every (re)connect signs a fresh URL instead of using
 * the library's own reconnect.
 *
 * Events: `connected`, `disconnected`, `message` (topic, parsed JSON body).
 */
export class NavienMqtt extends EventEmitter {
  constructor({ homeSeq, userSeq, getCredentials, log, connect }) {
    super();
    this.homeSeq = homeSeq;
    this.userSeq = userSeq;
    this.getCredentials = getCredentials;
    this.log = log;
    this._connect = connect ?? mqtt.connect;
    this.clientId = '';
    this.connected = false;
    this._client = null;
    this._stopping = false;
    this._attempt = 0;
    this._timer = null;
  }

  get topic() {
    return `${this.homeSeq}/smarttok/#`;
  }

  start() {
    this._stopping = false;
    this._open();
  }

  stop() {
    this._stopping = true;
    clearTimeout(this._timer);
    this._close();
  }

  _close() {
    const client = this._client;
    this._client = null;
    this.connected = false;
    if (client) {
      client.removeAllListeners();
      client.on('error', () => {});
      client.end(true);
    }
  }

  _retry(reason) {
    if (this._stopping || this._timer) {
      return;
    }
    this._close();
    const delay = RECONNECT_DELAYS_S[Math.min(this._attempt, RECONNECT_DELAYS_S.length - 1)];
    this._attempt += 1;
    this.log.debug(`MQTT ${reason}; reconnecting in ${delay}s.`);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._open();
    }, delay * 1000);
  }

  async _open() {
    let creds;
    try {
      creds = await this.getCredentials();
    } catch (err) {
      this.emit('credentials-error', err);
      this._retry(`credentials failed (${err.message})`);
      return;
    }
    if (this._stopping) {
      return;
    }
    if (!creds) {
      this._retry('got no AWS credentials');
      return;
    }

    // Same shape as the app: `{uuid}-U{userSeq}`.
    this.clientId = `${randomUUID()}-U${this.userSeq}`;
    const client = this._connect(`wss://${IOT_ENDPOINT}${buildSignedWsPath(creds)}`, {
      clientId: this.clientId,
      protocolVersion: 4,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 20_000,
    });
    this._client = client;

    client.on('connect', () => {
      client.subscribe(this.topic, { qos: 0 }, (err) => {
        if (err) {
          this._retry(`subscribe failed (${err.message})`);
          return;
        }
        this.connected = true;
        this._attempt = 0;
        this.log.debug(`MQTT subscribed to ${this.topic}`);
        this.emit('connected');
      });
    });
    client.on('message', (topic, payload) => {
      let body;
      try {
        body = JSON.parse(payload.toString('utf8'));
      } catch {
        this.log.debug(`Ignoring non-JSON MQTT message on ${topic}`);
        return;
      }
      this.emit('message', topic, body);
    });
    client.on('error', (err) => {
      this.log.debug(`MQTT error: ${err.message}`);
    });
    client.on('close', () => {
      if (this._client !== client) {
        return;
      }
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) {
        this.emit('disconnected');
      }
      this._retry('connection closed');
    });
  }
}
