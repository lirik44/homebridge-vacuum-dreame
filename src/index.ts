import type { API } from 'homebridge';

import { DreameVacuumPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/**
 * The entry point Homebridge calls when it loads the plugin.
 *
 * @param {API} api The Homebridge API.
 */
export default function registerPlugin(api: API): void {
  api.registerPlatform(PLATFORM_NAME, DreameVacuumPlatform);
}
