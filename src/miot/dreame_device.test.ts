import { jest } from '@jest/globals';
import type { MiioDevice } from 'node-miio';

import { loggerMock, type LoggerMock } from '../logger.mock.js';

import { DreameDevice, isDreame } from './dreame_device.js';

/**
 * Builds the `get_properties` response for the values a test cares about.
 *
 * @param {Record<string, unknown>} values The MIoT values the robot reports.
 * @returns {object[]} The response as node-miio would return it.
 */
const miotResults = (values: Record<string, unknown>) => Object.entries(values).map(([did, value]) => ({ did, code: 0, value }));

describe('DreameDevice', () => {
  let log: LoggerMock;
  let raw: jest.Mocked<MiioDevice>;
  let device: DreameDevice;

  beforeEach(() => {
    log = loggerMock();
    raw = {
      miioModel: 'dreame.vacuum.p2008',
      call: jest.fn(),
      destroy: jest.fn(),
      matches: jest.fn(),
      handle: { api: { parent: { socket: {} } } },
    } as unknown as jest.Mocked<MiioDevice>;
    device = new DreameDevice(raw, log);
  });

  /**
   * @returns {string[]} The calls the robot received, in order.
   */
  const calledActions = (): string[] => raw.call.mock.calls.map(([, args]) => (args as { did: string }).did);

  const poll = async (values: Record<string, unknown>) => {
    raw.call.mockResolvedValueOnce(miotResults(values) as never);
    return device.poll();
  };

  describe('isDreame', () => {
    test.each([
      ['dreame.vacuum.p2008', true],
      ['dreame.vacuum.mc1808', true],
      ['roborock.vacuum.s5', false],
      [undefined, false],
    ])('%s', (model, expected) => {
      expect(isDreame(model)).toBe(expected);
    });
  });

  describe('poll', () => {
    test('asks for every mapped property over MIoT', async () => {
      await poll({});
      expect(raw.call).toHaveBeenCalledWith('get_properties', [
        { did: 'battery_level', siid: 3, piid: 1 },
        { did: 'charging_state', siid: 3, piid: 2 },
        { did: 'device_fault', siid: 2, piid: 2 },
        { did: 'device_status', siid: 2, piid: 1 },
        { did: 'operating_mode', siid: 4, piid: 1 },
        { did: 'cleaning_mode', siid: 4, piid: 4 },
        { did: 'water_flow', siid: 4, piid: 5 },
      ]);
    });

    test('ignores the properties the robot failed to report', async () => {
      raw.call.mockResolvedValueOnce([
        { did: 'battery_level', code: 0, value: 55 },
        { did: 'cleaning_mode', code: -4004, value: null },
      ] as never);
      await device.poll();
      expect(device.properties).toStrictEqual({ battery_level: 55 });
    });

    test('maps the MIoT values onto a status', async () => {
      await expect(poll({ device_status: 1, charging_state: 2, battery_level: 42, cleaning_mode: 2, water_flow: 3, device_fault: 0 })).resolves.toStrictEqual({
        state: 'cleaning',
        batteryLevel: 42,
        charging: false,
        cleaning: true,
        mopping: false,
        returning: false,
        suction: 2,
        water: 3,
        fault: 0,
      });
    });

    test.each([
      [1, 'cleaning', true, false],
      [2, 'idle', false, false],
      [3, 'paused', false, false],
      [4, 'error', false, false],
      [5, 'returning', false, false],
      [6, 'charging', false, false],
      [7, 'mopping', true, true],
      [8, 'drying', false, false],
      [9, 'washing', false, false],
      [10, 'returning-washing', false, false],
      [11, 'building', true, false],
      [12, 'sweeping-and-mopping', true, true],
      [13, 'fully-charged', false, false],
      [14, 'updating', false, false],
      [99, 'idle', false, false],
    ])('device_status %s is reported as %s', async (deviceStatus, state, cleaning, mopping) => {
      const status = await poll({ device_status: deviceStatus });
      expect(status.state).toBe(state);
      expect(status.cleaning).toBe(cleaning);
      expect(status.mopping).toBe(mopping);
    });

    test.each([
      [5, true],
      [10, true],
      [1, false],
    ])('device_status %s reports returning as %s', async (deviceStatus, expected) => {
      await expect(poll({ device_status: deviceStatus })).resolves.toEqual(expect.objectContaining({ returning: expected }));
    });

    test.each([
      [1, true],
      [2, false],
      [4, true],
      [5, false],
      [99, false],
    ])('charging_state %s is reported as %s', async (chargingState, expected) => {
      await expect(poll({ charging_state: chargingState })).resolves.toEqual(expect.objectContaining({ charging: expected }));
    });

    test('reports a full battery on the charger as fully-charged', async () => {
      // The robot itself reports `idle` there, which would read as "stopped in the room".
      await expect(poll({ device_status: 2, charging_state: 1, battery_level: 100 })).resolves.toEqual(expect.objectContaining({ state: 'fully-charged' }));
    });

    test('reports the fault, and reports it as cleared once it goes away', async () => {
      await expect(poll({ device_status: 4, device_fault: 9 })).resolves.toEqual(expect.objectContaining({ fault: 9 }));
      await expect(poll({ device_status: 2, device_fault: 0 })).resolves.toEqual(expect.objectContaining({ fault: 0 }));
    });
  });

  describe('commands', () => {
    test.each([
      ['startCleaning', 'start_clean', { siid: 4, aiid: 1 }],
      ['stopCleaning', 'stop_clean', { siid: 4, aiid: 2 }],
      ['pause', 'stop_clean', { siid: 4, aiid: 2 }],
      ['locate', 'locate', { siid: 7, aiid: 1 }],
    ] as const)('%s calls the %s action', async (method, action, spec) => {
      await device[method]();
      expect(raw.call).toHaveBeenCalledWith('action', { did: action, ...spec, in: [] });
    });

    test('setSuction sets cleaning_mode', async () => {
      await device.setSuction(2);
      expect(raw.call).toHaveBeenCalledWith('set_properties', [{ did: 'cleaning_mode', siid: 4, piid: 4, value: 2 }]);
    });

    test('setWater sets water_flow', async () => {
      await device.setWater(3);
      expect(raw.call).toHaveBeenCalledWith('set_properties', [{ did: 'water_flow', siid: 4, piid: 5, value: 3 }]);
    });

    test('setWater reports that the robot has no "water off" level instead of silently dropping it', async () => {
      await device.setWater(0);
      expect(raw.call).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith('dreame.vacuum.p2008 has no "water off" level, keeping the current one');
    });

    describe('goHome', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      test('stops the cleaning and waits before sending the robot home', async () => {
        const going = device.goHome();
        await jest.advanceTimersByTimeAsync(0);
        // The robot ignores `home` while it is still cleaning or paused.
        expect(calledActions()).toStrictEqual(['stop_clean']);

        await jest.advanceTimersByTimeAsync(1000);
        await going;
        expect(calledActions()).toStrictEqual(['stop_clean', 'home']);
      });

      test('still goes home when the robot refuses to stop', async () => {
        raw.call.mockRejectedValueOnce(new Error('Could not complete call to device') as never);

        const going = device.goHome();
        await jest.advanceTimersByTimeAsync(1000);
        await going;

        expect(calledActions()).toStrictEqual(['stop_clean', 'home']);
        expect(log.debug).toHaveBeenCalledWith('stop_clean before home failed: Error: Could not complete call to device');
      });
    });
  });

  describe('refused calls', () => {
    // MIoT answers a rejected command with a non-zero code instead of failing the request.
    test('an action the robot refused is reported as an error', async () => {
      raw.call.mockResolvedValueOnce({ did: 'start_clean', code: -5 } as never);
      await expect(device.startCleaning()).rejects.toThrow('The robot refused "start_clean" (code -5)');
    });

    test('a property the robot refused is reported as an error', async () => {
      raw.call.mockResolvedValueOnce([{ did: 'water_flow', code: -4004 }] as never);
      await expect(device.setWater(3)).rejects.toThrow('The robot refused "water_flow" (code -4004)');
    });

    test('a successful call is not reported as an error', async () => {
      raw.call.mockResolvedValueOnce({ did: 'start_clean', code: 0 } as never);
      await expect(device.startCleaning()).resolves.toBeUndefined();
    });
  });

  describe('device info', () => {
    test('strips the separators Matter rejects from the serial number', async () => {
      raw.call.mockResolvedValueOnce({ mac: 'AA:BB:CC:DD:EE:FF', fw_ver: '1.2.3' } as never);
      await expect(device.deviceInfo()).resolves.toStrictEqual({ serialNumber: 'AABBCCDDEEFF', firmware: '1.2.3' });
    });

    test('falls back to the device id when there is no mac', async () => {
      raw.call.mockResolvedValueOnce({ did: '123456789' } as never);
      await expect(device.deviceInfo()).resolves.toStrictEqual({ serialNumber: '123456789', firmware: 'Unknown' });
    });

    test('survives miIO.info failing', async () => {
      raw.call.mockRejectedValue(new Error('user ack timeout') as never);
      await expect(device.deviceInfo()).resolves.toStrictEqual({ serialNumber: 'Unknown', firmware: 'Unknown' });
      expect(log.debug).toHaveBeenCalledWith('miIO.info failed: Error: user ack timeout');
    });
  });

  describe('connection', () => {
    test('is connected while the socket is there', () => {
      expect(device.connected).toBe(true);
    });

    test('is not connected once node-miio has torn the handle down', () => {
      Object.defineProperty(raw, 'handle', {
        get() {
          throw new Error('destroyed');
        },
      });
      expect(device.connected).toBe(false);
    });

    test('destroys the wrapped device', () => {
      device.destroy();
      expect(raw.destroy).toHaveBeenCalled();
    });
  });
});
