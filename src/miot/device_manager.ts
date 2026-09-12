import * as miio from 'node-miio';

import type { PluginLogger } from '../logger.js';

import { DreameDevice, isDreame, type VacuumStatus } from './dreame_device.js';

/** How long to wait before trying the connection again. */
const RECONNECT_DELAY_MS = 10_000;

/** How long to wait after a command before refreshing, so the controller sees the result. */
const REFRESH_AFTER_COMMAND_MS = 1500;

/** Thrown when the device answers but is not something this plugin can drive. */
export class UnsupportedDeviceError extends Error {}

export interface DeviceManagerOptions {
  ip: string;
  token: string;
  pollingIntervalMs: number;
  /** Called after every successful poll. */
  onStatus: (status: VacuumStatus) => void | Promise<void>;
}

/**
 * Owns the connection to one robot: connects, keeps polling it, and reconnects when the
 * connection dies. A single polling loop runs for the lifetime of the manager, so a
 * reconnection never leaves a second one behind.
 */
export class DeviceManager {
  private device?: DreameDevice;
  private connecting?: Promise<DreameDevice>;
  private pollTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private polling = false;
  private refreshTimer?: NodeJS.Timeout;
  private endWait?: () => void;
  private stopped = false;

  constructor(
    private readonly options: DeviceManagerOptions,
    private readonly log: PluginLogger,
  ) {}

  /**
   * Connects, retrying until it succeeds or the manager is stopped.
   *
   * Polling is started separately, so nothing is published before the accessory the state
   * belongs to exists.
   *
   * @returns {Promise<DreameDevice>} The connected robot.
   */
  async connectWithRetry(): Promise<DreameDevice> {
    for (;;) {
      try {
        return await this.connect();
      } catch (error) {
        // A device that is not a Dreame vacuum will not become one: retrying would only bury
        // the message telling the user what they actually configured.
        if (this.stopped || error instanceof UnsupportedDeviceError) {
          throw error;
        }
        this.log.error(`Connection failed, retrying in ${RECONNECT_DELAY_MS / 1000}s: ${error}`);
        await this.wait(RECONNECT_DELAY_MS);
        if (this.stopped) {
          throw error;
        }
      }
    }
  }

  stop(): void {
    this.stopped = true;
    // Release whoever is waiting to retry, or their promise would never settle.
    this.endWait?.();
    clearInterval(this.pollTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.refreshTimer);
    this.pollTimer = undefined;
    this.reconnectTimer = undefined;
    this.refreshTimer = undefined;
    this.destroyDevice();
  }

  /**
   * Runs a command against the robot, reconnecting first if the connection died.
   *
   * The state is deliberately not written here: a refresh is scheduled instead, so what the
   * controller ends up seeing is what the robot actually did.
   *
   * @param {string} name The command, for logging.
   * @param {(device: DreameDevice) => Promise<void>} run What to send to the robot.
   */
  async command(name: string, run: (device: DreameDevice) => Promise<void>): Promise<void> {
    const device = await this.connect();
    this.log.debug(`Sending ${name}`);
    await run(device);
    this.refreshSoon();
  }

  /** Polls the robot now, out of the regular cycle. */
  private refreshSoon(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.poll(), REFRESH_AFTER_COMMAND_MS);
  }

  private async connect(): Promise<DreameDevice> {
    if (this.device?.connected) {
      return this.device;
    }

    // Several commands can arrive while the connection is being established: they all wait
    // for the same attempt instead of opening a socket each.
    this.connecting ??= this.openConnection().finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  private async openConnection(): Promise<DreameDevice> {
    this.log.debug(`Connecting to ${this.options.ip}`);
    const raw = await miio.device({ address: this.options.ip, token: this.options.token });

    if (!isDreame(raw.miioModel)) {
      raw.destroy();
      throw new UnsupportedDeviceError(`"${raw.miioModel ?? 'unknown'}" is not a Dreame vacuum: this plugin only speaks the Dreame MIoT dialect`);
    }

    // A reconnection creates a brand new device: release the previous one, or its socket and
    // its internal timers are kept alive for as long as the plugin runs.
    this.destroyDevice();

    this.device = new DreameDevice(raw, this.log);
    this.log.info(`Connected to ${raw.miioModel} at ${this.options.ip}`);
    return this.device;
  }

  private destroyDevice(): void {
    if (!this.device) {
      return;
    }
    try {
      this.device.destroy();
    } catch (error) {
      this.log.debug(`Failed to release the previous connection: ${error}`);
    }
    this.device = undefined;
  }

  /** Starts the single polling loop that runs for the lifetime of the manager. */
  beginPolling(): void {
    if (this.pollTimer || this.stopped) {
      return;
    }
    this.pollTimer = setInterval(() => void this.poll(), this.options.pollingIntervalMs);
    void this.poll();
  }

  private async poll(): Promise<void> {
    // A slow robot must not stack polls on top of each other.
    if (this.polling || this.stopped) {
      return;
    }
    this.polling = true;

    try {
      const device = await this.connect();
      const status = await device.poll();
      this.log.debug(`Status ${JSON.stringify(status)} | Props ${JSON.stringify(device.properties)}`);
      await this.options.onStatus(status);
    } catch (error) {
      this.log.debug(`Poll failed: ${error}`);
      this.scheduleReconnect();
    } finally {
      this.polling = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.device?.connected || this.reconnectTimer || this.stopped) {
      return;
    }
    this.log.debug(`The connection is gone, reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => this.log.debug(`Reconnection failed: ${error}`));
    }, RECONNECT_DELAY_MS);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.endWait = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.endWait = done;
    });
  }
}
