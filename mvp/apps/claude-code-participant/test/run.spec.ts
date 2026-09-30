import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runParticipant } from '../src/run.js';
import { testServices } from './support.js';

/** A stand-in for the process: its stdio as streams a test drives, and signals it emits. */
function served() {
  const signals = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return { stdin, stdout, stderr, on: (signal: NodeJS.Signals, listener: () => void) => signals.on(signal, listener), signal: (signal: NodeJS.Signals) => signals.emit(signal) };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function running() {
  const services = testServices();
  const process = served();
  runParticipant(services.provider, process);
  const stages = () => services.host.logs.filter((line) => /^shutdown stage \d \(/.test(line)).map((line) => line.slice(0, line.indexOf('):') + 1));
  return { ...services, process, stages };
}

describe('runParticipant', () => {
  describe('SIGINT and SIGTERM', () => {
    it('start shutdown', () => {
      const { process, stages } = running();
      process.signal('SIGINT');
      expect(stages()).toEqual(['shutdown stage 1 (SIGINT)']);
    });

    it('move it on a stage each time', () => {
      const { process, stages } = running();
      process.signal('SIGINT');
      process.signal('SIGTERM');
      expect(stages()).toEqual(['shutdown stage 1 (SIGINT)', 'shutdown stage 2 (SIGTERM)']);
    });
  });

  describe('SIGHUP', () => {
    it('starts shutdown', () => {
      const { process, stages } = running();
      process.signal('SIGHUP');
      expect(stages()).toEqual(['shutdown stage 1 (SIGHUP)']);
    });

    it('never moves it on', () => {
      const { process, stages } = running();
      process.signal('SIGHUP');
      process.signal('SIGHUP');
      expect(stages()).toEqual(['shutdown stage 1 (SIGHUP)']);
    });
  });

  describe('stdin', () => {
    it('closing starts shutdown', async () => {
      const { process, stages } = running();
      process.stdin.end();
      await settle();
      expect(stages()).toEqual(['shutdown stage 1 (stdin closed)']);
    });

    it('closing and then SIGHUP, as a closing terminal gives them, stay in stage 1', async () => {
      const { process, stages } = running();
      process.stdin.end();
      await settle();
      process.signal('SIGHUP');
      expect(stages()).toEqual(['shutdown stage 1 (stdin closed)']);
    });

    it('closing after a SIGINT leaves shutdown in stage 1', async () => {
      const { process, stages } = running();
      process.signal('SIGINT');
      process.stdin.end();
      await settle();
      expect(stages()).toEqual(['shutdown stage 1 (SIGINT)']);
    });

    it('failing starts shutdown, naming the failure', async () => {
      const { process, stages } = running();
      process.stdin.destroy(new Error('read EIO'));
      await settle();
      expect(stages()).toEqual(['shutdown stage 1 (stdin failed: read EIO)']);
    });
  });

  it('survives stdout failing', () => {
    const { process } = running();
    expect(() => process.stdout.emit('error', new Error('write EPIPE'))).not.toThrow();
  });

  it('survives stderr failing', () => {
    const { process } = running();
    expect(() => process.stderr.emit('error', new Error('write EIO'))).not.toThrow();
  });
});
