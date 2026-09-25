// Shared by the harness (in the proof's process) and the capture wrapper
// (a separate process between the SDK and the real binary), so both stamp
// lines on the same wall clock and redact the same way.

import type { WriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// Wall-clock ISO 8601 with microseconds. Date alone stops at milliseconds;
// timeOrigin + now() carries the sub-millisecond part.
export function stamp(): string {
  const ms = performance.timeOrigin + performance.now();
  const whole = Math.floor(ms);
  const micros = Math.floor((ms - whole) * 1000);
  return new Date(whole).toISOString().replace('Z', `${String(micros).padStart(3, '0')}Z`);
}

// Anthropic API keys and Claude.ai OAuth access/refresh tokens all start
// `sk-ant-`. Nothing matching may reach disk under the repo, so every line
// is passed through here before it is written. A credential that doesn't
// start `sk-ant-` is not caught.
const TOKEN = /sk-ant-[A-Za-z0-9_-]{8,}/g;
export const REDACTED = 'sk-ant-[REDACTED]';

export function redact(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(TOKEN, () => {
    count += 1;
    return REDACTED;
  });
  return { text: out, count };
}

// Splits a byte stream into lines and writes each as `<stamp> <line>`. The
// stamp is when the line's newline arrived. A final line without a newline
// is written on end() and reported through `trailingPartial`.
export class LineRecorder {
  readonly out: WriteStream;
  readonly decoder = new StringDecoder('utf8');
  pending = '';
  redactions = 0;
  trailingPartial = false;

  constructor(out: WriteStream) {
    this.out = out;
  }

  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    let at = this.pending.indexOf('\n');
    while (at >= 0) {
      this.writeLine(this.pending.slice(0, at));
      this.pending = this.pending.slice(at + 1);
      at = this.pending.indexOf('\n');
    }
  }

  end(): Promise<void> {
    this.pending += this.decoder.end();
    if (this.pending.length > 0) {
      this.trailingPartial = true;
      this.writeLine(this.pending);
      this.pending = '';
    }
    return new Promise((resolve) => this.out.end(resolve));
  }

  writeLine(line: string): void {
    const { text, count } = redact(line);
    this.redactions += count;
    this.out.write(`${stamp()} ${text}\n`);
  }
}
