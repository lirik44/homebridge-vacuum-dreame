import type { VacuumStatus } from './miot/dreame_device.js';

/**
 * The clean modes exposed to Matter.
 *
 * Matter flattens cleaning into a single list of modes, while the robot keeps two independent
 * levels: suction (`cleaning_mode`, 0-3) and water (`water_flow`, 1-3). Each Matter mode
 * therefore sets exactly one of them, which is also how the robot behaves in the Xiaomi app:
 * the mop pad decides whether it mops, not the app.
 *
 * @see https://python-miio.readthedocs.io/en/latest/api/miio.integrations.dreame.vacuum.dreamevacuum_miot.html#miio.integrations.dreame.vacuum.dreamevacuum_miot.CleaningModeDreameF9
 */
export interface CleanMode {
  /** The Matter mode number, 1-based. */
  mode: number;
  label: string;
  /** The secondary `RvcCleanMode.ModeTag` name, resolved against matter.js at registration. */
  tag: 'LowNoise' | 'Min' | 'Day' | 'Max';
  /** The `cleaning_mode` this mode selects, for a vacuum mode. */
  suction?: number;
  /** The `water_flow` this mode selects, for a mop mode. */
  water?: number;
}

export const CLEAN_MODES: readonly CleanMode[] = [
  { mode: 1, label: 'Quiet', tag: 'LowNoise', suction: 0 },
  { mode: 2, label: 'Standard', tag: 'Min', suction: 1 },
  { mode: 3, label: 'Strong', tag: 'Day', suction: 2 },
  { mode: 4, label: 'Turbo', tag: 'Max', suction: 3 },
  { mode: 5, label: 'Light Mop', tag: 'Min', water: 1 },
  { mode: 6, label: 'Medium Mop', tag: 'Day', water: 2 },
  { mode: 7, label: 'High Mop', tag: 'Max', water: 3 },
];

/** The Matter run modes. Dreame robots either clean or they do not. */
export const RUN_MODE_IDLE = 1;
export const RUN_MODE_CLEANING = 2;

/**
 * Finds the clean mode matching what the robot reports.
 *
 * The robot always reports both levels, so the one that says what it is doing wins: the water
 * level while it mops, the suction power otherwise. Without that rule the two would fight over
 * the attribute on every poll.
 *
 * @param {VacuumStatus} status The status reported by the robot.
 * @returns {CleanMode?} The mode to report, if one matches.
 */
export function findCleanMode(status: Pick<VacuumStatus, 'suction' | 'water' | 'mopping'>): CleanMode | undefined {
  const byWater = CLEAN_MODES.find(({ water }) => water !== undefined && water === status.water);
  const bySuction = CLEAN_MODES.find(({ suction }) => suction !== undefined && suction === status.suction);

  return status.mopping ? (byWater ?? bySuction) : (bySuction ?? byWater);
}

/**
 * Finds the clean mode a controller selected.
 *
 * @param {number} mode The Matter mode number.
 * @returns {CleanMode?} The mode, if it is one this plugin exposes.
 */
export function cleanModeByNumber(mode: number): CleanMode | undefined {
  return CLEAN_MODES.find((cleanMode) => cleanMode.mode === mode);
}
