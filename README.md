# homebridge-navien-boiler

Homebridge plugin that puts a Korean Navien boiler room controller into Apple Home:
난방 (heating) as a thermostat, 온수 (hot water) as a second thermostat, and 외출 (away) as a switch.

It talks to the same cloud as the **나비엔 스마트** app. This is not an official API.

| Room controller | modelCode | Status |
| --- | --- | --- |
| NR-35D / NR-36D | `002` | Confirmed on a real NR-35D (2026-11-21): status, 실내난방 temperature, 온수 temperature, 외출 and 온수전용. Power off/on and 온돌난방 not yet tried |
| NR-40D | `003` | Protocol confirmed on real devices by the upstream Home Assistant project |
| NR-6x, NRM-35D, NRM-65D, NR-30D | others | Not supported (different value scaling or per-room control) |

## Requirements

- The room controller is registered and working in the **나비엔 스마트** app (not only the old 스마트톡 app).
- Homebridge 1.8 or newer (2.x works), Node.js 20 or newer.

## Install

From a packed tarball (`npm pack` in this folder):

```shell
sudo npm install -g homebridge-navien-boiler-0.1.0.tgz
```

On a `hb-service` install, use the plugin directory it reports (`hb-service status`) instead of a global install.

## Configure

Use the plugin settings in the Homebridge UI, or add a platform to `config.json`:

```json
{
  "platform": "NavienBoiler",
  "name": "Navien Boiler",
  "username": "<나비엔 스마트 ID>",
  "password": "<나비엔 스마트 password>",
  "heatingMode": "auto",
  "hotWater": true,
  "awaySwitch": true,
  "hotWaterOnlySwitch": false,
  "debug": false
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `heatingMode` | `auto` | What the heating thermostat's temperature means. `inside` = 실내난방 (room temperature), `ondol` = 온돌난방 (floor water temperature, typically 40-83°C), `both` = one thermostat per mode, `auto` = 실내난방 if the boiler has it, otherwise 온돌난방. |
| `hotWater` | `true` | Add the 온수 thermostat (a separate accessory, so it can be put in another room). |
| `awaySwitch` | `true` | Add a 외출 switch. Turning it off returns to heating. |
| `hotWaterOnlySwitch` | `false` | Add a 온수전용 switch (summer mode). |
| `homeSeq` | first home | Only for accounts with several homes; the log lists them. |
| `debug` | `false` | Log every message exchanged with the boiler. |

## How it behaves

- **Off / Heat.** "Off" powers the boiler off. "Heat" powers it on; if it comes back in 외출 or 온수전용 it is switched to heating.
- **A thermostat that shows Off ignores temperature changes.** Nothing turns the boiler on unless you turn it on.
- **Temperature steps and ranges come from the boiler** (0.5°C or 1°C, and the min/max it reports).
- **온수** has no on/off of its own; it follows the boiler. NR-35D / NR-40D do not report the actual water temperature, so the tile shows the setpoint as the current temperature. Boilers that set hot water in levels (1-3) instead of °C get no 온수 thermostat.
- **With `heatingMode: both`**, each thermostat stands for one mode and only the active one shows Heat. Avoid asking Siri to set "the temperature" for the whole room in that setup, because both thermostats would receive it.
- State changes made on the wall controller or in the app show up in Apple Home within seconds; the boiler reports them itself.

## Things to know

- **One login per account.** Navien allows a single session. While the plugin is connected, the 나비엔 스마트 app is logged out; when you log in to the app, the plugin logs back in on its next request (a command, or the 15-minute check), which logs the app out again.
- **A wrong password is tried once.** Navien locks an account after 5 failed logins, so after a rejected login the plugin stays idle until you fix the settings and restart Homebridge.
- **Cloud only.** If Navien's servers or your internet are down, the tiles show "No Response".
- The first time it connects, the plugin logs the boiler's feature list and status. That is the information to include when reporting a problem.

## Development

```shell
npm install
npm test
```

## Credits

The protocol (login flow, request envelopes, value encoding) follows the MIT-licensed Home Assistant integration
[ripe-avocado/navien_smart_ha](https://github.com/ripe-avocado/navien_smart_ha), which did the reverse engineering and
the real-device verification. The login flow was first documented by
[kyle-seongwoo-jun/homebridge-navien-smart](https://github.com/kyle-seongwoo-jun/homebridge-navien-smart).
