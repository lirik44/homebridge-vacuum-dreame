import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory } from 'homebridge';

import { validDevices, type DreamePlatformConfig } from './config.js';
import { pluginLogger, type PluginLogger } from './logger.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { DreameVacuum } from './vacuum_accessory.js';

/**
 * The platform: one entry per robot in the configuration, each exposed over Matter.
 *
 * Everything runs locally over miIO/MIoT — the robots are reached by IP and token on the LAN,
 * with no Xiaomi cloud session involved.
 */
export class DreameVacuumPlatform implements DynamicPlatformPlugin {
  private readonly vacuums: DreameVacuum[] = [];
  /** The accessories Homebridge restored from its Matter cache. */
  private readonly cached = new Map<string, MatterAccessory>();
  /** Writes through Homebridge's logger, promoting debug messages when the user asked for them. */
  private readonly pluginLog: PluginLogger;

  constructor(
    private readonly log: Logging,
    private readonly config: DreamePlatformConfig,
    private readonly api: API,
  ) {
    this.pluginLog = pluginLogger(log, config.debug === true);
    this.api.on('didFinishLaunching', () => void this.discoverDevices());
    this.api.on('shutdown', () => this.shutdown());
  }

  /**
   * Homebridge calls this for every HAP accessory it restored. This plugin exposes its
   * vacuums over Matter only — HomeKit has no robot vacuum service — so there is nothing to
   * restore here.
   *
   * @param {PlatformAccessory} accessory The restored accessory.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Ignoring the cached HAP accessory "${accessory.displayName}": this plugin only exposes Matter accessories.`);
  }

  /**
   * Homebridge calls this for every Matter accessory it restored from cache.
   *
   * @param {MatterAccessory} accessory The restored accessory.
   */
  configureMatterAccessory(accessory: MatterAccessory): void {
    this.log.debug(`Restored "${accessory.displayName}" from the Matter cache.`);
    this.cached.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    if (!this.api.isMatterEnabled()) {
      this.log.error(
        'Matter is not enabled for this bridge, so the vacuum cannot be exposed: HomeKit has no robot vacuum service, and this plugin has nothing to offer without Matter. Enable Matter for this bridge (or its child bridge) in the Homebridge UI and restart.',
      );
      return;
    }

    const devices = validDevices(this.config, this.pluginLog);
    if (devices.length === 0) {
      return;
    }

    // Each robot is set up on its own: a vacuum that is unplugged must not hold up the others.
    await Promise.all(
      devices.map(async (device) => {
        const vacuum = new DreameVacuum(this.api, this.pluginLog, device);
        this.vacuums.push(vacuum);
        try {
          await vacuum.register();
        } catch (error) {
          this.log.error(`Could not set up "${device.name}": ${error}`);
        }
      }),
    );

    await this.removeStaleAccessories();
  }

  /** Drops the cached accessories that no longer belong to a configured robot. */
  private async removeStaleAccessories(): Promise<void> {
    const live = new Set(this.vacuums.map((vacuum) => vacuum.uuid).filter((uuid): uuid is string => uuid !== undefined));
    const stale = [...this.cached.values()].filter((accessory) => !live.has(accessory.UUID));

    if (stale.length === 0) {
      return;
    }

    this.log.info(`Removing ${stale.length} cached vacuum(s) that are no longer configured: ${stale.map((accessory) => accessory.displayName).join(', ')}`);
    try {
      await this.api.matter?.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    } catch (error) {
      this.log.error(`Failed to remove the cached vacuums: ${error}`);
    }
  }

  private shutdown(): void {
    this.vacuums.forEach((vacuum) => vacuum.stop());
  }
}
