import type { LayoutSnapshot } from '../model/layout';
import data from './fixture.json';

export type Row = {
  conv: string;
  lastEvent: number;
  lastKind: string;
  title?: string;
  tags?: Record<string, string>;
  stale?: boolean;
};

export type Attachment = {
  conv: string;
  world: string;
  instanceId: string;
  attachedTs: number;
  lastPulse: number;
  cwd?: string;
  intervalS?: number;
};

export type Fixture = {
  takenFrom: string;
  takenAt: string;
  takenAtMs: number;
  tagKeys: Record<string, string>;
  conversations: Row[];
  attachments: Attachment[];
  layout: LayoutSnapshot;
  notes: Record<string, unknown>;
};

export const fixture = data as Fixture;
