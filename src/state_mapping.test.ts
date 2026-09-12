import type { VacuumStatus } from './miot/dreame_device.js';
import { RUN_MODE_CLEANING, RUN_MODE_IDLE } from './modes.js';
import { toMatterState } from './state_mapping.js';

const status = (overrides: Partial<VacuumStatus> = {}): VacuumStatus => ({
  state: 'idle',
  batteryLevel: 80,
  charging: false,
  cleaning: false,
  mopping: false,
  returning: false,
  suction: 1,
  water: 2,
  fault: 0,
  ...overrides,
});

describe('toMatterState', () => {
  test.each([
    ['cleaning', 'Running'],
    ['mopping', 'Running'],
    ['sweeping-and-mopping', 'Running'],
    ['building', 'Running'],
    ['paused', 'Paused'],
    ['returning', 'SeekingCharger'],
    ['returning-washing', 'SeekingCharger'],
    ['charging', 'Charging'],
    ['fully-charged', 'Docked'],
    ['drying', 'Docked'],
    ['washing', 'Docked'],
    ['error', 'Error'],
    ['idle', 'Stopped'],
    ['updating', 'Stopped'],
  ] as const)('%s is reported as %s', (state, expected) => {
    expect(toMatterState(status({ state })).operationalState).toBe(expected);
  });

  test('the run mode follows the operational state', () => {
    expect(toMatterState(status({ state: 'cleaning' })).runMode).toBe(RUN_MODE_CLEANING);
    expect(toMatterState(status({ state: 'paused' })).runMode).toBe(RUN_MODE_IDLE);
    expect(toMatterState(status({ state: 'idle' })).runMode).toBe(RUN_MODE_IDLE);
  });

  test('the clean mode follows what the robot is doing', () => {
    expect(toMatterState(status({ state: 'cleaning', suction: 3, water: 1 })).cleanMode).toBe(4);
    expect(toMatterState(status({ state: 'mopping', mopping: true, suction: 3, water: 1 })).cleanMode).toBe(5);
  });

  describe('battery', () => {
    test('reports the charge in the half percent Matter expects', () => {
      expect(toMatterState(status({ batteryLevel: 42 })).battery.percent).toBe(84);
    });

    test('clamps a charge the robot reports out of range', () => {
      expect(toMatterState(status({ batteryLevel: 120 })).battery.percent).toBe(200);
      expect(toMatterState(status({ batteryLevel: -5 })).battery.percent).toBe(0);
    });

    test.each([
      [100, 'Ok'],
      [20, 'Ok'],
      [19, 'Warning'],
      [10, 'Warning'],
      [9, 'Critical'],
    ] as const)('%s%% is %s', (batteryLevel, expected) => {
      expect(toMatterState(status({ batteryLevel })).battery.chargeLevel).toBe(expected);
    });

    test.each([
      [{ charging: false, batteryLevel: 50 }, 'IsNotCharging'],
      [{ charging: true, batteryLevel: 50 }, 'IsCharging'],
      [{ charging: true, batteryLevel: 100 }, 'IsAtFullCharge'],
    ] as const)('%o is %s', (overrides, expected) => {
      expect(toMatterState(status(overrides)).battery.chargeState).toBe(expected);
    });
  });

  test('carries the fault code through', () => {
    expect(toMatterState(status({ fault: 9 })).fault).toBe(9);
    expect(toMatterState(status({ fault: 0 })).fault).toBe(0);
  });
});
