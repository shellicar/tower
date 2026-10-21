import { describe, expect, it } from 'vitest';
import type { RowState } from '../types';
import { facetValues, matches } from './facets';

function row(conv: string, tags?: Record<string, string>): RowState {
  return { conv, lastEvent: 0, lastKind: 'message', tags };
}

const anyState = () => true;

describe('matches', () => {
  it('admits a row whose value is selected', () => {
    const expected = true;

    const actual = matches(row('1', { repo: 'a' }), { repo: ['a', 'b'] });

    expect(actual).toBe(expected);
  });

  it('rejects a row whose value is not selected', () => {
    const expected = false;

    const actual = matches(row('1', { repo: 'c' }), { repo: ['a', 'b'] });

    expect(actual).toBe(expected);
  });

  it('ignores a key whose filter selects nothing', () => {
    const expected = true;

    const actual = matches(row('1', { repo: 'a' }), { repo: [] });

    expect(actual).toBe(expected);
  });

  it('admits a row with no value for the key when null is selected', () => {
    const expected = true;

    const actual = matches(row('1'), { repo: [null] });

    expect(actual).toBe(expected);
  });

  it('rejects a row tagged "(untagged)" when null is selected', () => {
    const expected = false;

    const actual = matches(row('1', { repo: '(untagged)' }), { repo: [null] });

    expect(actual).toBe(expected);
  });

  it('rejects a row with no value for the key when "(untagged)" is selected', () => {
    const expected = false;

    const actual = matches(row('1'), { repo: ['(untagged)'] });

    expect(actual).toBe(expected);
  });

  it('requires every key to match', () => {
    const expected = false;

    const actual = matches(row('1', { repo: 'a', world: 'y' }), { repo: ['a'], world: ['x'] });

    expect(actual).toBe(expected);
  });
});

describe('facetValues', () => {
  it('breaks a tie on the value, lexicographically', () => {
    const expected = ['a', 'b', 'c'];

    const actual = facetValues(
      [row('1', { repo: 'b' }), row('2', { repo: 'c' }), row('3', { repo: 'a' })],
      'repo',
      {},
      anyState,
    ).map((v) => v.value);

    expect(actual).toEqual(expected);
  });

  it('sorts the no-value entry after every string at an equal count', () => {
    const expected = ['a', 'z', null];

    const actual = facetValues(
      [row('1'), row('2', { repo: 'z' }), row('3', { repo: 'a' })],
      'repo',
      {},
      anyState,
    ).map((v) => v.value);

    expect(actual).toEqual(expected);
  });

  it('counts rows with no value for the key under the no-value entry', () => {
    const expected = [
      { value: null, count: 2 },
      { value: 'a', count: 1 },
    ];

    const actual = facetValues(
      [row('1'), row('2'), row('3', { repo: 'a' })],
      'repo',
      {},
      anyState,
    );

    expect(actual).toEqual(expected);
  });

  it('keeps a selected value with no matching rows, at a count of zero', () => {
    const expected = [
      { value: 'a', count: 1 },
      { value: 'gone', count: 0 },
    ];

    const actual = facetValues([row('1', { repo: 'a' })], 'repo', { repo: ['a', 'gone'] }, anyState);

    expect(actual).toEqual(expected);
  });

  it('keeps the no-value entry when it is selected and nothing matches it', () => {
    const expected = [
      { value: 'a', count: 1 },
      { value: null, count: 0 },
    ];

    const actual = facetValues([row('1', { repo: 'a' })], 'repo', { repo: [null] }, anyState);

    expect(actual).toEqual(expected);
  });

  it('counts a literal "(untagged)" value separately from the no-value entry', () => {
    const expected = [
      { value: '(untagged)', count: 1 },
      { value: 'zeta', count: 1 },
      { value: null, count: 1 },
    ];

    const actual = facetValues(
      [row('1', { repo: '(untagged)' }), row('2', { repo: 'zeta' }), row('3')],
      'repo',
      {},
      anyState,
    );

    expect(actual).toEqual(expected);
  });

  it('counts only rows matching the other keys filters', () => {
    const expected = [{ value: 'a', count: 1 }];

    const actual = facetValues(
      [row('1', { repo: 'a', world: 'x' }), row('2', { repo: 'b', world: 'y' })],
      'repo',
      { world: ['x'] },
      anyState,
    );

    expect(actual).toEqual(expected);
  });

  it('ignores the expanded key own filter when counting', () => {
    const expected = [
      { value: 'a', count: 1 },
      { value: 'b', count: 1 },
    ];

    const actual = facetValues(
      [row('1', { repo: 'a' }), row('2', { repo: 'b' })],
      'repo',
      { repo: ['a'] },
      anyState,
    );

    expect(actual).toEqual(expected);
  });

  it('counts only rows the state filters admit', () => {
    const expected = [{ value: 'a', count: 1 }];

    const actual = facetValues(
      [row('1', { repo: 'a' }), row('2', { repo: 'b' })],
      'repo',
      {},
      (conv) => conv === '1',
    );

    expect(actual).toEqual(expected);
  });
});
