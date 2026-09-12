import type { MiioDevice } from 'node-miio';

import type { PluginLogger } from '../logger.js';

/**
 * Dreame vacuums connect over miIO but do not implement the Roborock RPCs (`app_start`,
 * `get_status`, ...): sending them makes the robot reply with
 * `{ code: -9999, message: 'user ack timeout' }`.
 *
 * This adapter keeps the `node-miio` connection (handshake, encryption, socket reuse) and
 * routes every read and command through the MIoT protocol (`get_properties` /
 * `set_properties` / `action`).
 *
 * The property/action map is the one shared by the F9 family: p2008 (F9), p2009 (D9),
 * p2028 (Z10 Pro), p2041o, p2150a and p2150o.
 *
 * @see https://home.miot-spec.com/spec/dreame.vacuum.p2008
 */

interface MiotProperty {
  siid: number;
  piid: number;
}

interface MiotAction {
  siid: number;
  aiid: number;
}

const PROPS: Record<string, MiotProperty> = {
  battery_level: { siid: 3, piid: 1 },
  charging_state: { siid: 3, piid: 2 },
  device_fault: { siid: 2, piid: 2 },
  device_status: { siid: 2, piid: 1 },
  operating_mode: { siid: 4, piid: 1 },
  cleaning_mode: { siid: 4, piid: 4 },
  water_flow: { siid: 4, piid: 5 },
};

const ACTIONS: Record<string, MiotAction> = {
  home: { siid: 3, aiid: 1 },
  locate: { siid: 7, aiid: 1 },
  start_clean: { siid: 4, aiid: 1 },
  stop_clean: { siid: 4, aiid: 2 },
};

/** The states the robot can report, as `device_status` values. */
export type VacuumState =
  | 'cleaning'
  | 'idle'
  | 'paused'
  | 'error'
  | 'returning'
  | 'charging'
  | 'mopping'
  | 'drying'
  | 'washing'
  | 'returning-washing'
  | 'building'
  | 'sweeping-and-mopping'
  | 'fully-charged'
  | 'updating';

/**
 * `device_status` mapped onto the states this plugin works with.
 *
 * @see https://python-miio.readthedocs.io/en/latest/api/miio.integrations.dreame.vacuum.dreamevacuum_miot.html#miio.integrations.dreame.vacuum.dreamevacuum_miot.DeviceStatus
 */
const DEVICE_STATUS: Record<number, VacuumState> = {
  1: 'cleaning', // Sweeping
  2: 'idle',
  3: 'paused',
  4: 'error',
  5: 'returning', // GoCharging
  6: 'charging',
  7: 'mopping',
  8: 'drying',
  9: 'washing',
  10: 'returning-washing',
  11: 'building', // Mapping run
  12: 'sweeping-and-mopping',
  13: 'fully-charged',
  14: 'updating',
};

const CHARGING_STATE: Record<number, boolean> = {
  1: true, // Charging
  2: false, // Discharging
  4: true, // Charging2
  5: false, // GoCharging
};

const CLEANING_STATES: VacuumState[] = ['cleaning', 'mopping', 'sweeping-and-mopping', 'building'];

/** States in which the water level, and not the suction power, says what the robot is doing. */
const MOPPING_STATES: VacuumState[] = ['mopping', 'sweeping-and-mopping'];

/** How long the robot needs between being stopped and accepting `home`. */
export const STOP_BEFORE_HOME_DELAY_MS = 1000;

/** A snapshot of what the robot is doing. */
export interface VacuumStatus {
  state: VacuumState;
  /** Battery charge, in percent. */
  batteryLevel: number;
  charging: boolean;
  cleaning: boolean;
  mopping: boolean;
  returning: boolean;
  /** The `cleaning_mode` (suction power) the robot is set to. */
  suction?: number;
  /** The `water_flow` (water level) the robot is set to. */
  water?: number;
  /** The fault code, `0` when there is none. */
  fault: number;
}

interface MiotPropertyResult {
  did: string;
  code: number;
  value: unknown;
}

/**
 * Whether the connected device is a Dreame vacuum this plugin can drive.
 *
 * @param {string?} model The `miioModel` reported by node-miio.
 * @returns {boolean} `true` when the model belongs to the Dreame family.
 */
export function isDreame(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('dreame.');
}

/**
 * @param {number} ms How long to wait.
 * @returns {Promise<void>} A promise resolving after `ms`.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Throws when the robot refused the call.
 *
 * MIoT answers a rejected command with a non-zero `code` instead of failing the request, so
 * without this check a command the robot ignored looks like it succeeded.
 *
 * @param {string} name The property or action that was called.
 * @param {unknown} result The response from the device.
 */
function assertMiotOk(name: string, result: unknown): void {
  const entries = Array.isArray(result) ? result : [result];
  for (const entry of entries) {
    const code = (entry as { code?: unknown } | null)?.code;
    if (typeof code === 'number' && code !== 0) {
      throw new Error(`The robot refused "${name}" (code ${code})`);
    }
  }
}

/** Speaks MIoT to a Dreame robot over an established `node-miio` connection. */
export class DreameDevice {
  private cache: Record<string, unknown> = {};

  constructor(
    private readonly raw: MiioDevice,
    private readonly log: PluginLogger,
  ) {}

  /** @returns {string} The model the robot reports. */
  get model(): string {
    return this.raw.miioModel ?? 'dreame.vacuum';
  }

  /** @returns {boolean} Whether the connection is still usable. */
  get connected(): boolean {
    try {
      return Boolean(this.raw.handle.api.parent.socket);
    } catch {
      // node-miio throws once the handle has been destroyed.
      return false;
    }
  }

  destroy(): void {
    this.raw.destroy();
  }

  // --- MIoT transport -------------------------------------------------------

  private rawCall<T>(method: string, args: unknown): Promise<T> {
    return this.raw.call<T>(method, args);
  }

  private async setProperty(name: string, value: number): Promise<unknown> {
    const spec = PROPS[name];
    if (!spec) {
      throw new Error(`Unknown Dreame property: ${name}`);
    }
    const result = await this.rawCall('set_properties', [{ did: name, ...spec, value }]);
    assertMiotOk(name, result);
    return result;
  }

  private async callAction(name: string, params: unknown[] = []): Promise<unknown> {
    const spec = ACTIONS[name];
    if (!spec) {
      throw new Error(`Unknown Dreame action: ${name}`);
    }
    const result = await this.rawCall('action', { did: name, ...spec, in: params });
    assertMiotOk(name, result);
    return result;
  }

  // --- state ----------------------------------------------------------------

  /**
   * Reads every mapped property and returns what the robot is doing.
   *
   * @returns {Promise<VacuumStatus>} The current status.
   */
  async poll(): Promise<VacuumStatus> {
    const params = Object.keys(PROPS).map((did) => ({ did, ...PROPS[did] }));
    const results = await this.rawCall<MiotPropertyResult[]>('get_properties', params);

    const values: Record<string, unknown> = {};
    for (const entry of results ?? []) {
      if (entry?.code === 0) {
        values[entry.did] = entry.value;
      }
    }
    this.cache = values;

    return this.status();
  }

  /** @returns {VacuumStatus} The status built from the last poll. */
  status(): VacuumStatus {
    const reported = DEVICE_STATUS[this.cache.device_status as number] ?? 'idle';
    const charging = CHARGING_STATE[this.cache.charging_state as number] ?? false;
    const batteryLevel = typeof this.cache.battery_level === 'number' ? this.cache.battery_level : 0;
    const fault = typeof this.cache.device_fault === 'number' ? this.cache.device_fault : 0;
    // The robot reports `idle` on a full charger, which reads as "stopped in the middle of the room".
    const state = charging && batteryLevel >= 100 ? 'fully-charged' : reported;

    return {
      state,
      batteryLevel,
      charging,
      cleaning: CLEANING_STATES.includes(state),
      mopping: MOPPING_STATES.includes(state),
      returning: state === 'returning' || state === 'returning-washing',
      suction: typeof this.cache.cleaning_mode === 'number' ? this.cache.cleaning_mode : undefined,
      water: typeof this.cache.water_flow === 'number' ? this.cache.water_flow : undefined,
      fault,
    };
  }

  /** @returns {Record<string, unknown>} The raw values from the last poll, for debug logging. */
  get properties(): Record<string, unknown> {
    return this.cache;
  }

  // --- device info ----------------------------------------------------------

  private async miioInfo(): Promise<Record<string, string> | undefined> {
    try {
      return await this.rawCall<Record<string, string>>('miIO.info', []);
    } catch (error) {
      this.log.debug(`miIO.info failed: ${error}`);
      return undefined;
    }
  }

  /**
   * @returns {Promise<{serialNumber: string, firmware: string}>} What the robot reports about itself.
   */
  async deviceInfo(): Promise<{ serialNumber: string; firmware: string }> {
    const info = await this.miioInfo();
    return {
      // Matter rejects separators in the serial number, so strip them.
      serialNumber: String(info?.mac ?? info?.did ?? 'Unknown').replace(/[^A-Za-z0-9]/g, ''),
      firmware: info?.fw_ver ?? 'Unknown',
    };
  }

  // --- commands -------------------------------------------------------------

  async startCleaning(): Promise<void> {
    await this.callAction('start_clean');
  }

  async stopCleaning(): Promise<void> {
    await this.callAction('stop_clean');
  }

  /** The F9 family has no dedicated pause action, so `stop_clean` halts the robot in place. */
  async pause(): Promise<void> {
    await this.callAction('stop_clean');
  }

  async goHome(): Promise<void> {
    // The robot ignores `home` while it is cleaning or paused, and then stops answering
    // altogether, so the cleaning is stopped first and it is given a moment to settle.
    // This is what node-miio's own Dreame implementation does.
    await this.stopCleaning().catch((error) => {
      this.log.debug(`stop_clean before home failed: ${error}`);
    });
    await delay(STOP_BEFORE_HOME_DELAY_MS);
    await this.callAction('home');
  }

  async locate(): Promise<void> {
    await this.callAction('locate');
  }

  /**
   * @param {number} level The `cleaning_mode` value, 0-3 on the F9 family.
   */
  async setSuction(level: number): Promise<void> {
    if (!Number.isFinite(level) || level < 0) {
      return;
    }
    await this.setProperty('cleaning_mode', level);
  }

  /**
   * @param {number} level The `water_flow` value, 1-3 on the F9 family.
   */
  async setWater(level: number): Promise<void> {
    if (!Number.isFinite(level)) {
      return;
    }
    if (level < 1) {
      // `water_flow` only accepts 1-3: the water is turned off by removing the mop pad, not
      // over MIoT. Selecting a vacuum-only mode therefore leaves the water level as it is.
      this.log.debug(`${this.model} has no "water off" level, keeping the current one`);
      return;
    }
    await this.setProperty('water_flow', level);
  }
}
