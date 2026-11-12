import { describe, expect, it } from 'vitest';
import { EXITS } from '../src/ExitCodes.js';

const codes = Object.values(EXITS).map((exit) => exit.code);

describe('EXITS', () => {
  it('gives every way of exiting a code of its own', () => {
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('exits clean with 0', () => {
    expect(EXITS.clean.code).toBe(0);
  });

  it('keeps every other code between 64 and 113', () => {
    expect(codes.filter((code) => code !== 0 && (code < 64 || code > 113))).toEqual([]);
  });
});
