<h1 align="center">Homebridge Dreame Vacuum</h1>

<p align="center">
    <a href="https://www.npmjs.com/package/homebridge"><img src="https://img.shields.io/badge/powered%20by-homebridge-blue" alt="powered by homebridge"></a>
    <a href="https://www.npmjs.com/package/node-miio"><img src="https://img.shields.io/badge/powered%20by-node--miio-blue" alt="powered by node-miio"></a>
    <img src="https://img.shields.io/badge/cloud-not%20required-brightgreen" alt="cloud not required">
</p>

---

**Homebridge Dreame Vacuum** exposes **Dreame robot vacuums** as native Matter robotic vacuum cleaners (RVC) through
Homebridge 2's built-in Matter support, so they show up in Apple Home and any other Matter controller with real vacuum
controls: start, stop, pause, return to dock, suction power, water level, battery.

Everything runs **locally over the miIO/MIoT protocol** — the plugin talks to the robot directly on your LAN using its
IP and token. No Xiaomi cloud session, no cloud tokens to refresh, and it keeps working when your internet connection
does not.

> ⚠️ **Matter must be enabled** for the bridge (or child bridge) this plugin runs on. HomeKit has no robot vacuum
> service, so without Matter there is nothing for this plugin to expose. The plugin says so in the log and stops.

## Why Matter, and why its own QR code

HAP — the protocol Homebridge normally speaks — has no robot vacuum accessory. A vacuum bridged into HomeKit can only
ever be faked as a switch or a fan. Matter does have an RVC device type, and Homebridge 2 ships it.

Apple Home refuses to pair a robot vacuum that is bridged alongside other devices, so Homebridge gives every RVC its
own Matter node. The vacuum therefore appears in the Homebridge UI with **its own QR code**, separate from the one for
the bridge itself. Scan that one.

## Features

- Start, stop, pause and return to dock
- Suction power: Quiet, Standard, Strong, Turbo
- Water level: Light, Medium, High
- Battery charge, charging state and a low-battery warning
- Operational state (idle, cleaning, mopping, drying, washing, returning, charging, error)
- Device faults surfaced as the Matter `OperationalError` attribute
- Identify — the robot announces where it is

### Limitations

- **No rooms.** Segment cleaning needs a vendor-specific payload that is not part of the shared MIoT spec, so no
  service areas are advertised: a cleaning request always cleans the whole place. Rooms that cannot actually be cleaned
  individually are worse than no rooms — they only add controls that silently do the wrong thing.
- **Pause halts the robot in place.** The F9 family has no dedicated pause action, so pause maps to `stop_clean`.
- **No "water off" level.** `water_flow` only accepts 1-3: the water is turned off by removing the mop pad, not over
  MIoT. Picking a suction mode therefore leaves the water level untouched.
- **Return to dock stops the robot first.** The robot ignores `home` while it is cleaning or paused, so the plugin
  stops it, waits a second, and only then sends it home.

## Supported models

The MIoT property/action map is shared across the F9 family, so these models are all expected to work. Only the F9 has
been verified.

| Model              | Code name              | Verified |
| ------------------ | ---------------------- | :------: |
| Dreame F9          | `dreame.vacuum.p2008`  |    ✅    |
| Dreame D9          | `dreame.vacuum.p2009`  |    ❔    |
| Dreame Z10 Pro     | `dreame.vacuum.p2028`  |    ❔    |
| Dreame Mop 2 Pro+  | `dreame.vacuum.p2041o` |    ❔    |
| Dreame Mop 2 Ultra | `dreame.vacuum.p2150a` |    ❔    |
| Dreame Mop 2       | `dreame.vacuum.p2150o` |    ❔    |

> ⚠️ The Dreame 1C (`dreame.vacuum.mc1808`) uses a **different** MIoT map and is not supported.

If you get another model working, please open an issue or a PR to add it to this table.

## Requirements

- Homebridge **2.4.0 or newer**, with Matter enabled for the bridge the plugin runs on
- Node.js 22, 24 or 26
- The **IP address and token** of the robot

The [Xiaomi Cloud Tokens Extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor) is the easiest way
to get the token.

> ⚠️ The robot must be paired in the **Xiaomi Home** app. Tokens cannot be extracted for robots that live only in the
> Dreamehome app. Reconfiguring the robot's Wi-Fi generates a new token, which then has to be updated here.

To check the IP and token before configuring the plugin, `python-miio` is handy:

    miiocli dreamevacuum --ip <IP> --token <TOKEN> status

If that prints the battery level and status, this plugin will work too.

## Installation

    npm install -g homebridge-vacuum-dreame

Or install it from the Homebridge UI by searching for **Dreame Vacuum**.

## Configuration

Add the platform through the Homebridge UI, or write it into `config.json`:

```json
{
  "platforms": [
    {
      "platform": "DreameVacuum",
      "name": "Dreame Vacuum",
      "devices": [
        {
          "name": "Vacuum",
          "ip": "192.168.1.50",
          "token": "0123456789abcdef0123456789abcdef"
        }
      ]
    }
  ]
}
```

| Option            | Default | Description                                                                |
| ----------------- | ------- | -------------------------------------------------------------------------- |
| `name`            | –       | The name the vacuum gets in your controller.                               |
| `ip`              | –       | The address of the robot. Give it a static lease.                          |
| `token`           | –       | The 32 character miIO token.                                               |
| `pollingInterval` | `10`    | How often to ask the robot what it is doing, in seconds. Minimum 2.        |
| `debug`           | `false` | Log every poll and command. Noisy — leave it off unless chasing a problem. |

Several vacuums can be listed in `devices`; each gets its own Matter node.

## Pairing

Restart Homebridge and look for the vacuum in the Homebridge UI: it has its **own QR code**, not the bridge's. Scan it
with the Home app.

The log confirms the robot answered:

    [Vacuum] Connected to dreame.vacuum.p2008 at 192.168.1.50
    [Vacuum] Exposed over Matter as a robotic vacuum cleaner (dreame.vacuum.p2008, firmware 4.1.8_1107)

## Troubleshooting

| Symptom                                  | What it usually means                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Matter is not enabled for this bridge`  | Turn Matter on for the bridge or child bridge in the Homebridge UI, then restart.                |
| `Connection failed, retrying in 10s`     | Wrong IP, or the robot is asleep or off its dock. The plugin keeps retrying on its own.          |
| `The robot refused "<command>" (code …)` | The robot rejected the command in its current state. The code comes straight from MIoT.          |
| `is not a Dreame vacuum`                 | The device at that address speaks a different miIO dialect; this plugin only handles `dreame.*`. |

## Credits

- [afharo/matterbridge-xiaomi-roborock](https://github.com/afharo/matterbridge-xiaomi-roborock) — where the Matter
  mapping for this family of plugins started
- [lirik44/matterbridge-xiaomi-dreame](https://github.com/lirik44/matterbridge-xiaomi-dreame) — the Matterbridge plugin
  this one is a port of, where the MIoT adapter was first written and proven
- [homebridge/homebridge](https://github.com/homebridge/homebridge) — Homebridge and its Matter support
- [rytilahti/python-miio](https://github.com/rytilahti/python-miio) and
  [node-miio](https://www.npmjs.com/package/node-miio) — reference for the Dreame MIoT mapping and the transport

## License

Apache-2.0
