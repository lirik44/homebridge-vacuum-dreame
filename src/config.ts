import type { PlatformConfig } from 'homebridge';

import type { PluginLogger } from './logger.js';

/** How often the robot is polled when the configuration does not say. */
export const DEFAULT_POLLING_INTERVAL_S = 10;

const MIN_POLLING_INTERVAL_S = 2;
const TOKEN_LENGTH = 32;

/** One robot, as configured by the user. */
export interface DeviceConfig {
  /** The name the robot gets in the controller. */
  name: string;
  /** The IP address of the robot on the LAN. */
  ip: string;
  /** The 32 character miIO token. */
  token: string;
  /** How often to poll the robot, in seconds. */
  pollingInterval?: number;
}

export interface DreamePlatformConfig extends PlatformConfig {
  devices?: Partial<DeviceConfig>[];
  debug?: boolean;
}

/**
 * Keeps the robots that are configured well enough to be usable.
 *
 * A bad entry is reported and skipped rather than taking the whole platform down with it, so
 * one mistyped token does not cost the user their other robots.
 *
 * @param {DreamePlatformConfig} config The platform configuration.
 * @param {PluginLogger} log Where to report the entries that were skipped.
 * @returns {DeviceConfig[]} The usable entries.
 */
export function validDevices(config: DreamePlatformConfig, log: PluginLogger): DeviceConfig[] {
  const devices = config.devices ?? [];

  if (devices.length === 0) {
    log.warn('No vacuums are configured: add one with its IP address and token.');
    return [];
  }

  return devices.filter((device, index): device is DeviceConfig => {
    const label = device.name ?? `the vacuum at position ${index + 1}`;

    if (!device.name) {
      log.error(`Skipping the vacuum at position ${index + 1}: it has no name.`);
      return false;
    }
    if (!device.ip) {
      log.error(`Skipping "${label}": it has no IP address.`);
      return false;
    }
    if (!device.token) {
      log.error(`Skipping "${label}": it has no token.`);
      return false;
    }
    if (device.token.length !== TOKEN_LENGTH) {
      log.error(`Skipping "${label}": the token must be ${TOKEN_LENGTH} characters, this one is ${device.token.length}.`);
      return false;
    }
    return true;
  });
}

/**
 * @param {DeviceConfig} device The configured robot.
 * @returns {number} How often to poll it, in milliseconds.
 */
export function pollingIntervalMs(device: DeviceConfig): number {
  const interval = device.pollingInterval ?? DEFAULT_POLLING_INTERVAL_S;
  return Math.max(MIN_POLLING_INTERVAL_S, interval) * 1000;
}
