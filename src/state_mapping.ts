import type { VacuumStatus } from './miot/dreame_device.js';
import { findCleanMode, RUN_MODE_CLEANING, RUN_MODE_IDLE } from './modes.js';

/**
 * The names below are the matter.js enum members, so they resolve against
 * `api.matter.types` without a table of magic numbers in the middle.
 */
export type OperationalStateName = 'Stopped' | 'Running' | 'Paused' | 'Error' | 'SeekingCharger' | 'Charging' | 'Docked';
export type BatteryChargeLevelName = 'Ok' | 'Warning' | 'Critical';
export type BatteryChargeStateName = 'IsCharging' | 'IsAtFullCharge' | 'IsNotCharging';

/** Every operational state this plugin reports, for the cluster's `operationalStateList`. */
export const OPERATIONAL_STATES: readonly OperationalStateName[] = ['Stopped', 'Running', 'Paused', 'Error', 'SeekingCharger', 'Charging', 'Docked'];

const BATTERY_WARNING_PERCENT = 20;
const BATTERY_CRITICAL_PERCENT = 10;

/** What the robot is doing, as Matter sees it. */
export interface MatterVacuumState {
  operationalState: OperationalStateName;
  /** The fault code to report as `operationalError`, `0` when there is none. */
  fault: number;
  runMode: number;
  /** The clean mode to report, or `undefined` when no level matches. */
  cleanMode?: number;
  battery: {
    percent: number;
    chargeLevel: BatteryChargeLevelName;
    chargeState: BatteryChargeStateName;
  };
}

/**
 * Translates a robot status into the Matter attributes that describe it.
 *
 * @param {VacuumStatus} status The status reported by the robot.
 * @returns {MatterVacuumState} The attribute values to publish.
 */
export function toMatterState(status: VacuumStatus): MatterVacuumState {
  const operationalState = operationalStateFor(status);

  return {
    operationalState,
    fault: status.fault,
    runMode: operationalState === 'Running' ? RUN_MODE_CLEANING : RUN_MODE_IDLE,
    cleanMode: findCleanMode(status)?.mode,
    battery: {
      // Matter reports the charge in half percent.
      percent: Math.max(0, Math.min(100, status.batteryLevel)) * 2,
      chargeLevel: chargeLevelFor(status.batteryLevel),
      chargeState: chargeStateFor(status),
    },
  };
}

/**
 * @param {VacuumStatus} status The status reported by the robot.
 * @returns {OperationalStateName} The Matter operational state.
 */
function operationalStateFor(status: VacuumStatus): OperationalStateName {
  switch (status.state) {
    case 'cleaning':
    case 'mopping':
    case 'sweeping-and-mopping':
    case 'building':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'returning':
    case 'returning-washing':
      return 'SeekingCharger';
    case 'charging':
      return 'Charging';
    // Drying and washing both happen at the dock, with the robot unavailable until they finish.
    case 'fully-charged':
    case 'drying':
    case 'washing':
      return 'Docked';
    case 'error':
      return 'Error';
    case 'idle':
    case 'updating':
      return 'Stopped';
  }
}

/**
 * @param {number} batteryLevel The charge in percent.
 * @returns {BatteryChargeLevelName} How urgent the charge is.
 */
function chargeLevelFor(batteryLevel: number): BatteryChargeLevelName {
  if (batteryLevel < BATTERY_CRITICAL_PERCENT) {
    return 'Critical';
  }
  return batteryLevel < BATTERY_WARNING_PERCENT ? 'Warning' : 'Ok';
}

/**
 * @param {VacuumStatus} status The status reported by the robot.
 * @returns {BatteryChargeStateName} Whether the robot is charging, and whether it is done.
 */
function chargeStateFor(status: VacuumStatus): BatteryChargeStateName {
  if (!status.charging) {
    return 'IsNotCharging';
  }
  return status.batteryLevel >= 100 ? 'IsAtFullCharge' : 'IsCharging';
}
