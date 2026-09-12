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

export type Fixture = {
  takenFrom: string;
  takenAt: string;
  tagKeys: Record<string, string>;
  conversations: Row[];
  layout: LayoutSnapshot;
  notes: Record<string, unknown>;
};

export const fixture = data as Fixture;
