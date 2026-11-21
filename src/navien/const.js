// Endpoints and protocol constants for the 나비엔 스마트 (Navien Smart, Korea) cloud.
// This is not an official API. The protocol details follow the MIT-licensed
// Home Assistant integration https://github.com/ripe-avocado/navien_smart_ha

export const API_URL = 'https://nskr.naviensmartcontrol.com/api/v2.0';
export const LOGIN_URL = 'https://member.naviensmartcontrol.com';

export const IOT_ENDPOINT = 'nskr-iot.naviensmartcontrol.com';
export const IOT_REGION = 'ap-northeast-2';
export const IOT_SERVICE = 'iotdevicegateway';

export const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 APP_NAVIENSMART_IOS';

export const REQUEST_TIMEOUT_MS = 30_000;

export const CODE_SUCCESS = 200;
export const CODE_NOT_AUTHORIZED = 404; // session taken over (one login per account)
export const CODE_TOKEN_EXPIRED = 407;

export const SERVICE_BOILER = 100;
export const BOILER_TOPIC_PREFIX = 'smarttok';

// modelCode -> family. These share one request envelope and send temperatures in plain °C.
// NR-40D is verified on real devices upstream; NR-35D/36D uses the same app code path.
export const SUPPORTED_MODELS = {
  '002': 'NR-35D / NR-36D',
  '003': 'NR-40D',
};

// status.operationMode
export const MODE_OFF = 1;
export const MODE_GOOUT = 4;
export const MODE_INSIDE = 5;
export const MODE_ONDOL = 6;
export const MODE_REPEAT_RESERVATION = 7;
export const MODE_DAY_RESERVATION = 8;
export const MODE_HOTWATER_ONLY = 10;

export const MODE_NAMES = {
  [MODE_OFF]: '꺼짐',
  [MODE_GOOUT]: '외출',
  [MODE_INSIDE]: '실내난방',
  [MODE_ONDOL]: '온돌난방',
  [MODE_REPEAT_RESERVATION]: '반복예약',
  [MODE_DAY_RESERVATION]: '24시간예약',
  [MODE_HOTWATER_ONLY]: '온수전용',
};

// [request name, response name]
export const REQ_START = ['status/start', 'res/start']; // feature list
export const REQ_STATUS = ['status', 'res']; // current status
export const REQ_CONTROL = ['control', 'res'];

// request.mode for REQ_CONTROL
export const CMD_POWER_ON = 'power-on';
export const CMD_POWER_OFF = 'power-off';
export const CMD_GOOUT = 'goout-on';
export const CMD_INSIDE = 'inside-heat';
export const CMD_ONDOL = 'ondol-heat';
export const CMD_HOTWATER = 'hotwater-temperature';
export const CMD_HOTWATER_ONLY = 'only-hotwater';

// The app waits for the feature response before asking for status; we just pause.
export const STATUS_DELAY_MS = 8_000;
// Ask for status when a boiler has been silent this long. It normally reports changes itself.
export const STALE_MS = 15 * 60_000;
// After a command, ask for status if the boiler has not reported by itself within this time.
export const READBACK_MS = 4_000;
export const RECONNECT_DELAYS_S = [5, 15, 30, 60, 120, 300];
