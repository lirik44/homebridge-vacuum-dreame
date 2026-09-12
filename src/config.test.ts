import { pollingIntervalMs, validDevices, type DreamePlatformConfig } from './config.js';
import { loggerMock } from './logger.mock.js';

const platformConfig = (devices: unknown[]): DreamePlatformConfig => ({ platform: 'DreameVacuum', devices }) as DreamePlatformConfig;

const token = '0'.repeat(32);

describe('validDevices', () => {
  test('keeps a well configured vacuum', () => {
    const log = loggerMock();
    expect(validDevices(platformConfig([{ name: 'Vacuum', ip: '192.168.1.50', token }]), log)).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  test('warns when nothing is configured', () => {
    const log = loggerMock();
    expect(validDevices(platformConfig([]), log)).toStrictEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No vacuums are configured'));
  });

  test.each([
    [{ ip: '192.168.1.50', token }, 'it has no name'],
    [{ name: 'Vacuum', token }, 'it has no IP address'],
    [{ name: 'Vacuum', ip: '192.168.1.50' }, 'it has no token'],
    [{ name: 'Vacuum', ip: '192.168.1.50', token: 'too-short' }, 'the token must be 32 characters'],
  ])('skips %o and says why', (device, reason) => {
    const log = loggerMock();
    expect(validDevices(platformConfig([device]), log)).toStrictEqual([]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

  test('one bad entry does not cost the user the others', () => {
    const log = loggerMock();
    const devices = validDevices(
      platformConfig([
        { name: 'Broken', ip: '192.168.1.50' },
        { name: 'Vacuum', ip: '192.168.1.51', token },
      ]),
      log,
    );
    expect(devices.map(({ name }) => name)).toStrictEqual(['Vacuum']);
  });
});

describe('pollingIntervalMs', () => {
  const device = { name: 'Vacuum', ip: '192.168.1.50', token };

  test('polls every ten seconds by default', () => {
    expect(pollingIntervalMs(device)).toBe(10_000);
  });

  test('honours the configured interval', () => {
    expect(pollingIntervalMs({ ...device, pollingInterval: 30 })).toBe(30_000);
  });

  test('refuses to hammer the robot faster than it can answer', () => {
    expect(pollingIntervalMs({ ...device, pollingInterval: 0.1 })).toBe(2000);
  });
});

describe('pluginLogger', () => {
  test('leaves the logger alone by default', async () => {
    const { pluginLogger } = await import('./logger.js');
    const log = loggerMock();

    pluginLogger(log, false).debug('quiet');

    expect(log.debug).toHaveBeenCalledWith('quiet');
    expect(log.info).not.toHaveBeenCalled();
  });

  test('promotes debug messages when the user asked for them', async () => {
    const { pluginLogger } = await import('./logger.js');
    const log = loggerMock();

    // Otherwise they only show up when the whole of Homebridge runs in debug mode.
    pluginLogger(log, true).debug('loud');

    expect(log.info).toHaveBeenCalledWith('loud');
    expect(log.debug).not.toHaveBeenCalled();
  });
});
