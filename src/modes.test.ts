import { cleanModeByNumber, CLEAN_MODES, findCleanMode } from './modes.js';

describe('clean modes', () => {
  test('exposes four suction levels and three water levels', () => {
    expect(CLEAN_MODES.filter(({ suction }) => suction !== undefined)).toHaveLength(4);
    expect(CLEAN_MODES.filter(({ water }) => water !== undefined)).toHaveLength(3);
  });

  test('numbers the modes from one, without gaps', () => {
    expect(CLEAN_MODES.map(({ mode }) => mode)).toStrictEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  describe('findCleanMode', () => {
    test('reports the suction level while vacuuming', () => {
      // The robot reports a water level at all times, which must not win here.
      expect(findCleanMode({ suction: 2, water: 3, mopping: false })?.label).toBe('Strong');
    });

    test('reports the water level while mopping', () => {
      expect(findCleanMode({ suction: 1, water: 3, mopping: true })?.label).toBe('High Mop');
    });

    test('falls back to the other level when the reported one is unknown', () => {
      expect(findCleanMode({ suction: 99, water: 2, mopping: false })?.label).toBe('Medium Mop');
      expect(findCleanMode({ suction: 0, water: 99, mopping: true })?.label).toBe('Quiet');
    });

    test('reports nothing when neither level is known', () => {
      expect(findCleanMode({ suction: 99, water: 99, mopping: false })).toBeUndefined();
      expect(findCleanMode({ mopping: false })).toBeUndefined();
    });
  });

  describe('cleanModeByNumber', () => {
    test('finds the mode a controller selected', () => {
      expect(cleanModeByNumber(4)).toEqual(expect.objectContaining({ label: 'Turbo', suction: 3 }));
      expect(cleanModeByNumber(5)).toEqual(expect.objectContaining({ label: 'Light Mop', water: 1 }));
    });

    test('returns nothing for a mode this plugin does not expose', () => {
      expect(cleanModeByNumber(42)).toBeUndefined();
    });
  });
});
