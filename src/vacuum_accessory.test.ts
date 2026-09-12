import { jest } from '@jest/globals';
import type { API, MatterAccessory } from 'homebridge';

import type { DeviceConfig } from './config.js';
import { loggerMock, type LoggerMock } from './logger.mock.js';
import { BAT_CHARGE_LEVEL, BAT_CHARGE_STATE, ERROR_STATE, OPERATIONAL_STATE } from './matter_constants.js';
import type { DeviceManagerOptions } from './miot/device_manager.js';
import type { DreameDevice, VacuumStatus } from './miot/dreame_device.js';

type CommandRunner = (device: DreameDevice) => Promise<void>;

const device = {
  model: 'dreame.vacuum.p2008',
  deviceInfo: jest.fn(async () => ({ serialNumber: 'AABBCCDDEEFF', firmware: '4.1.8' })),
  startCleaning: jest.fn(async () => undefined),
  stopCleaning: jest.fn(async () => undefined),
  pause: jest.fn(async () => undefined),
  goHome: jest.fn(async () => undefined),
  locate: jest.fn(async () => undefined),
  setSuction: jest.fn(async (_level: number) => undefined),
  setWater: jest.fn(async (_level: number) => undefined),
} as unknown as jest.Mocked<DreameDevice>;

const manager = {
  connectWithRetry: jest.fn(async () => device),
  beginPolling: jest.fn(),
  command: jest.fn(async (_name: string, run: CommandRunner) => run(device)),
  stop: jest.fn(),
};

/** The options the accessory built its manager with, so tests can drive `onStatus`. */
let managerOptions: DeviceManagerOptions;

const DeviceManagerMock = jest.fn((options: DeviceManagerOptions) => {
  managerOptions = options;
  return manager;
});

jest.unstable_mockModule('./miot/device_manager.js', () => ({ DeviceManager: DeviceManagerMock }));

const { DreameVacuum } = await import('./vacuum_accessory.js');

const config: DeviceConfig = { name: 'Пылесос', ip: '192.168.1.50', token: '0'.repeat(32) };

const status = (overrides: Partial<VacuumStatus> = {}): VacuumStatus => ({
  state: 'idle',
  batteryLevel: 100,
  charging: false,
  cleaning: false,
  mopping: false,
  returning: false,
  suction: 3,
  water: 3,
  fault: 0,
  ...overrides,
});

describe('DreameVacuum', () => {
  let log: LoggerMock;
  let api: API;
  let registerPlatformAccessories: jest.Mock<(plugin: string, platform: string, accessories: MatterAccessory[]) => Promise<void>>;
  let updateAccessoryState: jest.Mock<(uuid: string, cluster: string, attributes: Record<string, unknown>) => Promise<void>>;
  let registered: MatterAccessory;

  const build = async () => {
    const vacuum = new DreameVacuum(api, log, config);
    await vacuum.register();
    registered = registerPlatformAccessories.mock.calls[0][2][0];
    return vacuum;
  };

  /**
   * Runs one of the accessory's command handlers.
   *
   * @param {string} cluster The cluster the handler belongs to.
   * @param {string} command The handler to run.
   * @param {unknown} request The request the controller would send.
   * @returns {Promise<void>} Whatever the handler returns.
   */
  const invoke = async (cluster: 'rvcRunMode' | 'rvcCleanMode' | 'rvcOperationalState' | 'identify', command: string, request?: unknown) => {
    const handlers = registered.handlers as unknown as Record<string, Record<string, (request?: unknown) => Promise<void>>>;
    await handlers[cluster][command](request);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    log = loggerMock();
    registerPlatformAccessories = jest.fn(async () => undefined);
    updateAccessoryState = jest.fn(async () => undefined);
    api = {
      hap: { uuid: { generate: (value: string) => `uuid:${value}` } },
      matter: {
        deviceTypes: { RoboticVacuumCleaner: { deviceType: 116 } },
        registerPlatformAccessories,
        updateAccessoryState,
      },
    } as unknown as API;
  });

  describe('register', () => {
    test('waits for the robot, then exposes it as a robotic vacuum cleaner', async () => {
      const vacuum = await build();

      expect(manager.connectWithRetry).toHaveBeenCalled();
      expect(registered.deviceType).toStrictEqual({ deviceType: 116 });
      expect(registered.displayName).toBe('Пылесос');
      expect(registered.serialNumber).toBe('AABBCCDDEEFF');
      expect(registered.firmwareRevision).toBe('4.1.8');
      expect(registered.model).toBe('dreame.vacuum.p2008');
      // The robot's own serial identifies the accessory, so its IP can change freely.
      expect(vacuum.uuid).toBe('uuid:homebridge-vacuum-dreame:AABBCCDDEEFF');
    });

    test('exposes the run modes and the seven clean modes', async () => {
      await build();

      expect(registered.clusters?.rvcRunMode?.supportedModes?.map(({ label }) => label)).toStrictEqual(['Idle', 'Cleaning']);
      expect(registered.clusters?.rvcCleanMode?.supportedModes?.map(({ label }) => label)).toStrictEqual([
        'Quiet',
        'Standard',
        'Strong',
        'Turbo',
        'Light Mop',
        'Medium Mop',
        'High Mop',
      ]);
    });

    test('starts polling only once the accessory exists', async () => {
      await build();

      expect(manager.beginPolling).toHaveBeenCalled();
      expect(registerPlatformAccessories.mock.invocationCallOrder[0]).toBeLessThan(manager.beginPolling.mock.invocationCallOrder[0]);
    });

    test('refuses to run on a bridge without Matter', async () => {
      api = { ...api, matter: undefined } as unknown as API;
      await expect(new DreameVacuum(api, log, config).register()).rejects.toThrow('Matter is not enabled');
    });
  });

  describe('command handlers', () => {
    beforeEach(async () => {
      await build();
    });

    test('cleaning starts the robot, idle stops it', async () => {
      await invoke('rvcRunMode', 'changeToMode', { newMode: 2 });
      expect(device.startCleaning).toHaveBeenCalled();

      await invoke('rvcRunMode', 'changeToMode', { newMode: 1 });
      expect(device.stopCleaning).toHaveBeenCalled();
    });

    test('a vacuum mode sets the suction power', async () => {
      await invoke('rvcCleanMode', 'changeToMode', { newMode: 4 });
      expect(device.setSuction).toHaveBeenCalledWith(3);
      expect(device.setWater).not.toHaveBeenCalled();
    });

    test('a mop mode sets the water level', async () => {
      await invoke('rvcCleanMode', 'changeToMode', { newMode: 6 });
      expect(device.setWater).toHaveBeenCalledWith(2);
      expect(device.setSuction).not.toHaveBeenCalled();
    });

    test('an unknown clean mode is reported, not sent to the robot', async () => {
      await invoke('rvcCleanMode', 'changeToMode', { newMode: 42 });
      expect(device.setSuction).not.toHaveBeenCalled();
      expect(device.setWater).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring unknown clean mode 42'));
    });

    test.each([
      ['pause', 'pause'],
      ['resume', 'startCleaning'],
      ['goHome', 'goHome'],
    ] as const)('%s calls %s', async (command, method) => {
      await invoke('rvcOperationalState', command);
      expect(device[method]).toHaveBeenCalled();
    });

    test('identify makes the robot announce itself', async () => {
      await invoke('identify', 'identify');
      expect(device.locate).toHaveBeenCalled();
    });

    test('no handler writes the state of the cluster it belongs to', async () => {
      // Writing from inside a handler deadlocks the command: matter.js waits for the lock the
      // command itself holds, and the controller ends up calling the vacuum unresponsive.
      await invoke('rvcRunMode', 'changeToMode', { newMode: 2 });
      await invoke('rvcCleanMode', 'changeToMode', { newMode: 4 });
      await invoke('rvcOperationalState', 'goHome');
      await invoke('rvcOperationalState', 'pause');

      expect(updateAccessoryState).not.toHaveBeenCalled();
    });
  });

  describe('publishing the polled state', () => {
    beforeEach(async () => {
      await build();
    });

    const publish = async (value: VacuumStatus) => managerOptions.onStatus(value);

    test('reports the operational state, run mode, clean mode and battery', async () => {
      await publish(status({ state: 'cleaning', suction: 2, batteryLevel: 55 }));

      expect(updateAccessoryState).toHaveBeenCalledWith('uuid:homebridge-vacuum-dreame:AABBCCDDEEFF', 'rvcOperationalState', {
        operationalState: OPERATIONAL_STATE.Running,
        operationalError: { errorStateId: ERROR_STATE.NoError },
      });
      expect(updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'rvcRunMode', { currentMode: 2 });
      expect(updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'rvcCleanMode', { currentMode: 3 });
      expect(updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'powerSource', {
        batPercentRemaining: 110,
        batChargeLevel: BAT_CHARGE_LEVEL.Ok,
        batChargeState: BAT_CHARGE_STATE.IsNotCharging,
      });
    });

    test('reports a fault, and reports it cleared once it goes away', async () => {
      await publish(status({ state: 'error', fault: 9 }));
      expect(updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'rvcOperationalState', {
        operationalState: OPERATIONAL_STATE.Error,
        operationalError: { errorStateId: ERROR_STATE.UnableToCompleteOperation, errorStateDetails: 'Device fault 9' },
      });

      updateAccessoryState.mockClear();
      await publish(status({ state: 'idle', fault: 0 }));
      expect(updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'rvcOperationalState', {
        operationalState: OPERATIONAL_STATE.Stopped,
        operationalError: { errorStateId: ERROR_STATE.NoError },
      });
    });

    test('writes nothing when a poll changed nothing', async () => {
      await publish(status());
      updateAccessoryState.mockClear();

      await publish(status());
      expect(updateAccessoryState).not.toHaveBeenCalled();
    });

    test('retries a cluster whose write failed', async () => {
      updateAccessoryState.mockRejectedValueOnce(new Error('Matter server not started'));
      await publish(status());
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to publish rvcOperationalState'));

      updateAccessoryState.mockClear();
      await publish(status());
      expect(updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'rvcOperationalState', expect.any(Object));
    });
  });

  test('stop releases the robot', async () => {
    const vacuum = await build();
    vacuum.stop();
    expect(manager.stop).toHaveBeenCalled();
  });
});
