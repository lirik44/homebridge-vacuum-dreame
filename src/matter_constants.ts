/**
 * The Matter enum values this plugin publishes.
 *
 * `api.matter.types` exposes only some of the cluster namespaces — RvcOperationalState is
 * there, RvcRunMode, RvcCleanMode and PowerSource are not — so rather than taking half of
 * the values from the API and spelling out the other half, all of them are declared here.
 * They come from the Matter cluster specification; the values match matter.js.
 */

/** `RvcRunMode.ModeTag` */
export const RUN_MODE_TAG = {
  Idle: 16384,
  Cleaning: 16385,
} as const;

/** `RvcCleanMode.ModeTag`, both the common tags and the RVC-specific ones. */
export const CLEAN_MODE_TAG = {
  LowNoise: 3,
  Min: 6,
  Max: 7,
  Day: 9,
  Vacuum: 16385,
  Mop: 16386,
} as const;

/** `RvcOperationalState.OperationalState` */
export const OPERATIONAL_STATE = {
  Stopped: 0,
  Running: 1,
  Paused: 2,
  Error: 3,
  SeekingCharger: 64,
  Charging: 65,
  Docked: 66,
} as const;

/** `RvcOperationalState.ErrorState` */
export const ERROR_STATE = {
  NoError: 0,
  UnableToCompleteOperation: 2,
} as const;

/** `PowerSource.BatChargeLevel` */
export const BAT_CHARGE_LEVEL = {
  Ok: 0,
  Warning: 1,
  Critical: 2,
} as const;

/** `PowerSource.BatChargeState` */
export const BAT_CHARGE_STATE = {
  Unknown: 0,
  IsCharging: 1,
  IsAtFullCharge: 2,
  IsNotCharging: 3,
} as const;

/** Matter caps `ErrorStateDetails` at 64 characters. */
export const MAX_ERROR_DETAILS_LENGTH = 64;
