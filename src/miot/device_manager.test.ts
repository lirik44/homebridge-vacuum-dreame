import { jest } from '@jest/globals';
import type { MiioDevice } from 'node-miio';

import { loggerMock, type LoggerMock } from '../logger.mock.js';

import type { DeviceManager as DeviceManagerType, DeviceManagerOptions } from './device_manager.js';
import type { VacuumStatus } from './dreame_device.js';

const miioConnect = jest.fn<() => Promise<MiioDevice>>();
jest.unstable_mockModule('node-miio', () => ({ device: miioConnect }));

const { DeviceManager } = await import('./device_manager.js');

/**
 * @param {string} model The model the robot reports during the handshake.
 * @returns {jest.Mocked<MiioDevice>} A robot answering `get_properties` with a docked, idle status.
 */
const rawDevice = (model = 'dreame.vacuum.p2008'): jest.Mocked<MiioDevice> =>
  ({
    miioModel: model,
    call: jest.fn(async () => [
      { did: 'device_status', code: 0, value: 2 },
      { did: 'battery_level', code: 0, value: 100 },
    ]),
    destroy: jest.fn(),
    matches: jest.fn(),
    handle: { api: { parent: { socket: {} } } },
  }) as unknown as jest.Mocked<MiioDevice>;

describe('DeviceManager', () => {
  let log: LoggerMock;
  let onStatus: jest.Mock<(status: VacuumStatus) => void>;
  let manager: DeviceManagerType;

  const options = (overrides: Partial<DeviceManagerOptions> = {}): DeviceManagerOptions => ({
    ip: '192.168.1.50',
    token: '0'.repeat(32),
    pollingIntervalMs: 10_000,
    onStatus,
    ...overrides,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    log = loggerMock();
    onStatus = jest.fn();
    miioConnect.mockReset();
  });

  afterEach(() => {
    manager?.stop();
    jest.useRealTimers();
  });

  describe('connectWithRetry', () => {
    test('connects to the configured robot', async () => {
      const raw = rawDevice();
      miioConnect.mockResolvedValue(raw);
      manager = new DeviceManager(options(), log);

      const device = await manager.connectWithRetry();

      expect(miioConnect).toHaveBeenCalledWith({ address: '192.168.1.50', token: '0'.repeat(32) });
      expect(device.model).toBe('dreame.vacuum.p2008');
    });

    test('keeps retrying until the robot answers', async () => {
      const raw = rawDevice();
      miioConnect.mockRejectedValueOnce(new Error('no route to host')).mockResolvedValue(raw);
      manager = new DeviceManager(options(), log);

      const connecting = manager.connectWithRetry();
      await jest.advanceTimersByTimeAsync(10_000);

      await expect(connecting).resolves.toBeDefined();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Connection failed, retrying'));
    });

    test('refuses a device that is not a Dreame vacuum', async () => {
      const raw = rawDevice('roborock.vacuum.s5');
      miioConnect.mockResolvedValue(raw);
      manager = new DeviceManager(options(), log);

      // It will never become one, so it must fail instead of retrying forever.
      await expect(manager.connectWithRetry()).rejects.toThrow('is not a Dreame vacuum');
      // The connection it opened to find that out is released.
      expect(raw.destroy).toHaveBeenCalled();
    });

    test('opens a single connection for simultaneous callers', async () => {
      miioConnect.mockResolvedValue(rawDevice());
      manager = new DeviceManager(options(), log);

      await Promise.all([manager.connectWithRetry(), manager.connectWithRetry()]);

      expect(miioConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('polling', () => {
    test('polls immediately and then on the configured interval', async () => {
      miioConnect.mockResolvedValue(rawDevice());
      manager = new DeviceManager(options({ pollingIntervalMs: 5000 }), log);
      await manager.connectWithRetry();

      manager.beginPolling();
      await jest.advanceTimersByTimeAsync(0);
      expect(onStatus).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(5000);
      expect(onStatus).toHaveBeenCalledTimes(2);
    });

    test('reports what the robot answered', async () => {
      miioConnect.mockResolvedValue(rawDevice());
      manager = new DeviceManager(options(), log);
      await manager.connectWithRetry();

      manager.beginPolling();
      await jest.advanceTimersByTimeAsync(0);

      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'idle', batteryLevel: 100 }));
    });

    test('runs one loop however often it is started', async () => {
      miioConnect.mockResolvedValue(rawDevice());
      manager = new DeviceManager(options({ pollingIntervalMs: 5000 }), log);
      await manager.connectWithRetry();

      manager.beginPolling();
      manager.beginPolling();
      await jest.advanceTimersByTimeAsync(5000);

      // Two loops would have polled twice per interval.
      expect(onStatus).toHaveBeenCalledTimes(2);
    });

    test('does not stack polls on top of a slow robot', async () => {
      const raw = rawDevice();
      let pending: (() => void) | undefined;
      raw.call.mockImplementation(() => new Promise((resolve) => (pending = () => resolve([] as never))));
      miioConnect.mockResolvedValue(raw);
      manager = new DeviceManager(options({ pollingIntervalMs: 1000 }), log);
      await manager.connectWithRetry();

      manager.beginPolling();
      await jest.advanceTimersByTimeAsync(5000);
      expect(raw.call).toHaveBeenCalledTimes(1);

      pending?.();
      await jest.advanceTimersByTimeAsync(1000);
      expect(raw.call).toHaveBeenCalledTimes(2);
    });

    test('stops waiting to retry when the plugin shuts down', async () => {
      miioConnect.mockRejectedValue(new Error('no route to host'));
      manager = new DeviceManager(options(), log);

      const connecting = manager.connectWithRetry();
      await jest.advanceTimersByTimeAsync(0);
      manager.stop();

      await expect(connecting).rejects.toThrow('no route to host');
    });

    test('reconnects after the connection dies, releasing the old one', async () => {
      const dead = rawDevice();
      const fresh = rawDevice();
      miioConnect.mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh);
      manager = new DeviceManager(options(), log);
      await manager.connectWithRetry();

      dead.call.mockRejectedValue(new Error('Could not complete call to device') as never);
      Object.defineProperty(dead, 'handle', {
        get() {
          throw new Error('destroyed');
        },
      });

      manager.beginPolling();
      await jest.advanceTimersByTimeAsync(0);

      // The dead connection is noticed and replaced within the same poll.
      expect(miioConnect).toHaveBeenCalledTimes(2);
      expect(dead.destroy).toHaveBeenCalled();
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));
    });
  });

  describe('command', () => {
    test('sends the command and refreshes so the controller sees the result', async () => {
      miioConnect.mockResolvedValue(rawDevice());
      manager = new DeviceManager(options(), log);
      const run = jest.fn(async () => undefined);

      await manager.command('start_clean', run);
      expect(run).toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1500);
      expect(onStatus).toHaveBeenCalledTimes(1);
    });

    test('lets a refused command through to the caller', async () => {
      miioConnect.mockResolvedValue(rawDevice());
      manager = new DeviceManager(options(), log);

      await expect(
        manager.command('start_clean', async () => {
          throw new Error('The robot refused "start_clean" (code -5)');
        }),
      ).rejects.toThrow('code -5');
    });
  });

  describe('stop', () => {
    test('releases the robot and stops polling', async () => {
      const raw = rawDevice();
      miioConnect.mockResolvedValue(raw);
      manager = new DeviceManager(options({ pollingIntervalMs: 1000 }), log);
      await manager.connectWithRetry();
      manager.beginPolling();
      await jest.advanceTimersByTimeAsync(0);

      manager.stop();
      onStatus.mockClear();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(raw.destroy).toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalled();
    });
  });
});
