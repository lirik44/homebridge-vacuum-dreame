import type { API, MatterAccessory, MatterAPI } from 'homebridge';

import { pollingIntervalMs, type DeviceConfig } from './config.js';
import { deviceLogger, type PluginLogger } from './logger.js';
import { BAT_CHARGE_LEVEL, BAT_CHARGE_STATE, CLEAN_MODE_TAG, ERROR_STATE, MAX_ERROR_DETAILS_LENGTH, OPERATIONAL_STATE, RUN_MODE_TAG } from './matter_constants.js';
import { DeviceManager } from './miot/device_manager.js';
import type { VacuumStatus } from './miot/dreame_device.js';
import { CLEAN_MODES, cleanModeByNumber, RUN_MODE_CLEANING, RUN_MODE_IDLE } from './modes.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { OPERATIONAL_STATES, toMatterState } from './state_mapping.js';

const MANUFACTURER = 'Dreame';

/** What the robot told us about itself once it answered. */
interface DeviceIdentity {
  uuid: string;
  model: string;
  firmware: string;
  serialNumber: string;
}

/**
 * One robot, exposed as a Matter robotic vacuum cleaner.
 *
 * Homebridge gives an RVC its own Matter node — Apple Home refuses to bridge one — so the
 * vacuum is commissioned with its own QR code, next to the Homebridge bridge itself.
 */
export class DreameVacuum {
  private readonly log: PluginLogger;
  private readonly manager: DeviceManager;
  /** The last payload published per cluster, so an unchanged poll writes nothing. */
  private readonly published = new Map<string, string>();
  private identity?: DeviceIdentity;

  constructor(
    private readonly api: API,
    log: PluginLogger,
    private readonly config: DeviceConfig,
  ) {
    this.log = deviceLogger(log, config.name);
    this.manager = new DeviceManager(
      {
        ip: config.ip,
        token: config.token,
        pollingIntervalMs: pollingIntervalMs(config),
        onStatus: (status) => this.publish(status),
      },
      this.log,
    );
  }

  /** @returns {string?} The accessory UUID, once the robot has been reached. */
  get uuid(): string | undefined {
    return this.identity?.uuid;
  }

  /**
   * Waits for the robot, registers it over Matter and starts following it.
   *
   * Nothing is registered before the robot answers: its serial number identifies the
   * accessory, and there is no point exposing controls for a vacuum that cannot be reached.
   *
   * @returns {Promise<void>} Resolves once the accessory is registered and polling.
   */
  async register(): Promise<void> {
    const matter = this.api.matter;
    if (!matter) {
      throw new Error('Matter is not enabled for this bridge');
    }

    const device = await this.manager.connectWithRetry();
    const { serialNumber, firmware } = await device.deviceInfo();

    this.identity = {
      serialNumber,
      firmware,
      model: device.model,
      uuid: this.api.hap.uuid.generate(`${PLUGIN_NAME}:${serialNumber}`),
    };

    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.buildAccessory(matter, this.identity)]);
    this.log.info(`Exposed over Matter as a robotic vacuum cleaner (${this.identity.model}, firmware ${firmware})`);

    this.manager.beginPolling();
  }

  stop(): void {
    this.manager.stop();
  }

  private buildAccessory(matter: MatterAPI, identity: DeviceIdentity): MatterAccessory {
    return {
      UUID: identity.uuid,
      displayName: this.config.name,
      deviceType: matter.deviceTypes.RoboticVacuumCleaner,
      manufacturer: MANUFACTURER,
      model: identity.model,
      serialNumber: identity.serialNumber,
      firmwareRevision: identity.firmware,
      softwareVersion: identity.firmware,
      context: {},
      clusters: {
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: RUN_MODE_IDLE, modeTags: [{ value: RUN_MODE_TAG.Idle }] },
            { label: 'Cleaning', mode: RUN_MODE_CLEANING, modeTags: [{ value: RUN_MODE_TAG.Cleaning }] },
          ],
          currentMode: RUN_MODE_IDLE,
        },
        rvcCleanMode: {
          supportedModes: CLEAN_MODES.map(({ mode, label, tag, water }) => ({
            label,
            mode,
            modeTags: [{ value: water === undefined ? CLEAN_MODE_TAG.Vacuum : CLEAN_MODE_TAG.Mop }, { value: CLEAN_MODE_TAG[tag] }],
          })),
          currentMode: CLEAN_MODES[0].mode,
        },
        rvcOperationalState: {
          operationalStateList: OPERATIONAL_STATES.map((state) => ({ operationalStateId: OPERATIONAL_STATE[state] })),
          operationalState: OPERATIONAL_STATE.Docked,
          operationalError: { errorStateId: ERROR_STATE.NoError },
          phaseList: null,
          currentPhase: null,
        },
        powerSource: {
          batPercentRemaining: 200,
          batChargeLevel: BAT_CHARGE_LEVEL.Ok,
          batChargeState: BAT_CHARGE_STATE.Unknown,
        },
      },
      // Handlers never write cluster state: Homebridge applies the command to the state once
      // they resolve, and writing the cluster being commanded from inside its own handler
      // deadlocks the command until the controller declares the whole vacuum unresponsive.
      handlers: {
        rvcRunMode: {
          changeToMode: async (request) => {
            if (request?.newMode === RUN_MODE_CLEANING) {
              await this.manager.command('start_clean', (device) => device.startCleaning());
            } else {
              await this.manager.command('stop_clean', (device) => device.stopCleaning());
            }
          },
        },
        rvcCleanMode: {
          changeToMode: async (request) => {
            const cleanMode = cleanModeByNumber(request?.newMode ?? -1);
            if (!cleanMode) {
              this.log.warn(`Ignoring unknown clean mode ${request?.newMode}`);
              return;
            }
            const { suction, water } = cleanMode;
            if (suction !== undefined) {
              await this.manager.command(`cleaning_mode=${suction}`, (device) => device.setSuction(suction));
            } else if (water !== undefined) {
              await this.manager.command(`water_flow=${water}`, (device) => device.setWater(water));
            }
          },
        },
        rvcOperationalState: {
          pause: async () => {
            await this.manager.command('pause', (device) => device.pause());
          },
          resume: async () => {
            await this.manager.command('resume', (device) => device.startCleaning());
          },
          goHome: async () => {
            await this.manager.command('home', (device) => device.goHome());
          },
        },
        identify: {
          identify: async () => {
            await this.manager.command('locate', (device) => device.locate());
          },
        },
      },
    };
  }

  /**
   * Publishes what the robot reports to the Matter clusters.
   *
   * @param {VacuumStatus} status The status from the last poll.
   */
  private async publish(status: VacuumStatus): Promise<void> {
    if (!this.identity) {
      return;
    }
    const { uuid } = this.identity;
    const state = toMatterState(status);

    await this.update(uuid, 'rvcOperationalState', {
      operationalState: OPERATIONAL_STATE[state.operationalState],
      operationalError: operationalError(state.fault),
    });
    await this.update(uuid, 'rvcRunMode', { currentMode: state.runMode });
    if (state.cleanMode !== undefined) {
      await this.update(uuid, 'rvcCleanMode', { currentMode: state.cleanMode });
    }
    await this.update(uuid, 'powerSource', {
      batPercentRemaining: state.battery.percent,
      batChargeLevel: BAT_CHARGE_LEVEL[state.battery.chargeLevel],
      batChargeState: BAT_CHARGE_STATE[state.battery.chargeState],
    });
  }

  private async update(uuid: string, cluster: 'rvcOperationalState' | 'rvcRunMode' | 'rvcCleanMode' | 'powerSource', attributes: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify(attributes);
    if (this.published.get(cluster) === payload) {
      return;
    }

    try {
      await this.api.matter?.updateAccessoryState(uuid, cluster, attributes);
      this.published.set(cluster, payload);
    } catch (error) {
      // A failed write must not be remembered as published, or it would never be retried.
      this.published.delete(cluster);
      this.log.error(`Failed to publish ${cluster}: ${error}`);
    }
  }
}

/**
 * Translates a vendor fault code into the Matter operational error.
 *
 * The codes are vendor-specific, so anything non-zero is reported as a generic failure that
 * carries the original code.
 *
 * @param {number} fault The fault code reported by the robot, `0` when there is none.
 * @returns {object} The `operationalError` attribute value.
 */
function operationalError(fault: number): { errorStateId: number; errorStateDetails?: string } {
  if (fault === 0) {
    return { errorStateId: ERROR_STATE.NoError };
  }

  return {
    errorStateId: ERROR_STATE.UnableToCompleteOperation,
    errorStateDetails: `Device fault ${fault}`.slice(0, MAX_ERROR_DETAILS_LENGTH),
  };
}
