// Entries as Claude Code 2.1.283 appended them in a live run: a prompt, its
// reminders, a reply that thinks and reads an image, the tool result, the
// answer, then a second prompt cancelled mid-reply. Bookkeeping fields Claude
// Code adds to every entry (cwd, version, userType and so on) are left out,
// and long values are cut short.

import type { RecordEntry } from '../src/ConversationEntries.js';

/** A 32x32 PNG, as the Read tool returned it. */
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKUlEQVR4nO3NMQ0AAAzDsPLHODAj0X6Wcse5ZNr2DgAAAAAAAAAAAIo9tPVwLraRYtkAAAAASUVORK5CYII=';

export const QUEUE_OPERATION: RecordEntry = { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-30T18:45:18.732Z', sessionId: '0c77fb4e-655e-41f2-be80-558ad2aaf6dc' };

export const PROMPT: RecordEntry = {
  parentUuid: null,
  isSidechain: false,
  promptId: '8e207d4b-67cc-4bb9-82e5-c439ff7c7a85',
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Use the Read tool to read ./red.png, then tell me its colour in one short sentence.' }] },
  uuid: '0901146d-42ea-4cc2-82ec-ea1869071a90',
  timestamp: '2026-09-30T18:45:18.752Z',
  permissionMode: 'default',
  promptSource: 'sdk',
  turnOrigin: 'sdk',
};

export const DATE_ATTACHMENT: RecordEntry = {
  parentUuid: '01a8a8c2-4e5a-448a-8d7a-32adf2b6ba99',
  isSidechain: false,
  attachment: { type: 'date', date: '2026-10-01' },
  type: 'attachment',
  uuid: '1712add6-8e65-47c2-bad2-b0c7e57ba3c4',
  timestamp: '2026-09-30T18:45:18.780Z',
  rendered: [{ content: "<system-reminder>\nToday's date is 2026-10-01.\n</system-reminder>" }],
};

export const AI_TITLE: RecordEntry = { type: 'ai-title', aiTitle: 'Read red.png and describe color', sessionId: '0c77fb4e-655e-41f2-be80-558ad2aaf6dc' };

const FIRST_REPLY = { model: 'claude-sonnet-5', id: 'msg_011Cfa7tGtLqx2Z2oMBY8bBc', type: 'message', role: 'assistant', stop_reason: 'tool_use' };

export const THINKING: RecordEntry = {
  parentUuid: '5e57ad0a-4bf7-4e22-b8e0-fa076f0edd4a',
  isSidechain: false,
  message: { ...FIRST_REPLY, content: [{ type: 'thinking', thinking: "No user memory is relevant here, so I'll just read the file directly.\n\n", signature: 'Et0CCrwBCBIYAipA' }] },
  apiBlockIndex: 0,
  requestId: 'req_011Cfa7tGXm7Ab2an4weHNWU',
  type: 'assistant',
  uuid: '14ed1665-bcdb-4459-a5db-ebeb9f214ea2',
  timestamp: '2026-09-30T18:45:20.572Z',
};

export const TOOL_USE: RecordEntry = {
  parentUuid: '14ed1665-bcdb-4459-a5db-ebeb9f214ea2',
  isSidechain: false,
  message: { ...FIRST_REPLY, content: [{ type: 'tool_use', id: 'toolu_018yQgWWFdcauitggzkBdjjb', name: 'Read', input: { file_path: '/work/red.png' }, caller: { type: 'direct' } }] },
  apiBlockIndex: 1,
  requestId: 'req_011Cfa7tGXm7Ab2an4weHNWU',
  type: 'assistant',
  uuid: 'f7817f2f-a5a5-4efe-9fff-07180ce42dc8',
  timestamp: '2026-09-30T18:45:20.580Z',
};

export const IMAGE_TOOL_RESULT: RecordEntry = {
  parentUuid: 'f7817f2f-a5a5-4efe-9fff-07180ce42dc8',
  isSidechain: false,
  promptId: '8e207d4b-67cc-4bb9-82e5-c439ff7c7a85',
  type: 'user',
  message: {
    role: 'user',
    content: [{ tool_use_id: 'toolu_018yQgWWFdcauitggzkBdjjb', type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: PNG_BASE64, media_type: 'image/png' } }] }],
  },
  uuid: 'fb53da29-2143-434a-a644-6067c7216c30',
  timestamp: '2026-09-30T18:45:20.694Z',
  toolUseResult: { type: 'image', file: { base64: PNG_BASE64, type: 'image/png', originalSize: 98 } },
  sourceToolAssistantUUID: 'f7817f2f-a5a5-4efe-9fff-07180ce42dc8',
};

export const TOKENS_REMINDER: RecordEntry = {
  parentUuid: '1518160a-5740-4589-83bf-77b2e3a9a921',
  isSidechain: false,
  attachment: { type: 'total_tokens_reminder', text: '<total_tokens>14971961 tokens left</total_tokens>' },
  type: 'attachment',
  uuid: '37803ed8-07c5-47ee-a527-5fbdf92cbec2',
  timestamp: '2026-09-30T18:45:20.715Z',
};

export const ANSWER: RecordEntry = {
  parentUuid: '37803ed8-07c5-47ee-a527-5fbdf92cbec2',
  isSidechain: false,
  message: { model: 'claude-sonnet-5', id: 'msg_011Cfa7tQvHPkLXPj2N62PZ1', type: 'message', role: 'assistant', content: [{ type: 'text', text: "It's red." }], stop_reason: 'end_turn' },
  apiBlockIndex: 0,
  requestId: 'req_011Cfa7tQbCCPSHbWQdEhqKS',
  type: 'assistant',
  uuid: '23b57e1f-93f8-4120-a092-50cc46718524',
  timestamp: '2026-09-30T18:45:20.690Z',
};

export const SECOND_PROMPT: RecordEntry = {
  parentUuid: '23b57e1f-93f8-4120-a092-50cc46718524',
  isSidechain: false,
  promptId: '035238cd-7396-457d-80e4-c0d75f8a3be0',
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Write a 1500-word essay about lighthouses. No tools.' }] },
  uuid: '405eabcf-7311-49d3-9110-49c5155ba825',
  timestamp: '2026-09-30T18:45:28.915Z',
  promptSource: 'sdk',
  turnOrigin: 'sdk',
};

export const PARTIAL_REPLY: RecordEntry = {
  parentUuid: '7f13620b-6db8-4d9d-83a1-f38178fa97b5',
  isSidechain: false,
  message: { model: 'claude-sonnet-5', id: 'msg_011Cfa7u4F7emtmFWfksTy9y', type: 'message', role: 'assistant', content: [{ type: 'text', text: '# Lighthouses: Sentinels of the Shore\n\nFor centuries' }], stop_reason: null },
  apiBlockIndex: 0,
  type: 'assistant',
  uuid: '1f76a208-9877-48bd-b16d-6345ea2c3931',
  timestamp: '2026-09-30T18:45:34.915Z',
  isAbortedMidStream: true,
};

export const INTERRUPT_MARKER: RecordEntry = {
  parentUuid: '1f76a208-9877-48bd-b16d-6345ea2c3931',
  isSidechain: false,
  promptId: '035238cd-7396-457d-80e4-c0d75f8a3be0',
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  uuid: '22e9b9b6-6443-4577-97b3-1c0e32ea561b',
  timestamp: '2026-09-30T18:45:34.916Z',
};

// Two parallel Reads whose tool results are written between the pieces of
// the reply that called them: call A, result A, call B, result B, then the
// answer. Built in the shape of the entries above, not captured from a run.

const PARALLEL_REPLY = { model: 'claude-sonnet-5', id: 'msg_01ParallelReadsReply', type: 'message', role: 'assistant', stop_reason: 'tool_use' };

export const CALL_A: RecordEntry = {
  isSidechain: false,
  message: { ...PARALLEL_REPLY, content: [{ type: 'tool_use', id: 'toolu_A', name: 'Read', input: { file_path: '/work/a.txt' } }] },
  apiBlockIndex: 0,
  type: 'assistant',
  uuid: 'a0000000-0000-4000-8000-00000000000a',
};

export const RESULT_A: RecordEntry = {
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_A', type: 'tool_result', content: 'alpha' }] },
  uuid: 'a0000000-0000-4000-8000-0000000000a1',
  sourceToolAssistantUUID: 'a0000000-0000-4000-8000-00000000000a',
};

export const CALL_B: RecordEntry = {
  isSidechain: false,
  message: { ...PARALLEL_REPLY, content: [{ type: 'tool_use', id: 'toolu_B', name: 'Read', input: { file_path: '/work/b.txt' } }] },
  apiBlockIndex: 1,
  type: 'assistant',
  uuid: 'b0000000-0000-4000-8000-00000000000b',
};

export const RESULT_B: RecordEntry = {
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_B', type: 'tool_result', content: 'beta' }] },
  uuid: 'b0000000-0000-4000-8000-0000000000b1',
  sourceToolAssistantUUID: 'b0000000-0000-4000-8000-00000000000b',
};

export const PARALLEL_ANSWER: RecordEntry = {
  isSidechain: false,
  message: { model: 'claude-sonnet-5', id: 'msg_01ParallelReadsAnswer', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'alpha and beta.' }], stop_reason: 'end_turn' },
  apiBlockIndex: 0,
  type: 'assistant',
  uuid: 'c0000000-0000-4000-8000-00000000000c',
};

// Entries recorded from Claude Code 2.1.285 driven through the SDK (the
// proof runs `background` and `compact`), with bookkeeping fields left out and
// the summary text cut short.

export const RECORDED_TOKENS_REMINDER: RecordEntry = {
  parentUuid: '4340591b-cb26-451d-bdf5-7ce9b80dae50',
  isSidechain: false,
  attachment: { type: 'total_tokens_reminder', text: '<total_tokens>14981384 tokens left</total_tokens>' },
  type: 'attachment',
  uuid: 'de80b017-0495-4eb2-80b7-45687b044a8e',
  timestamp: '2026-10-02T16:43:29.006Z',
  rendered: [{ content: '<system-reminder>\n<total_tokens>14981384 tokens left</total_tokens>\n</system-reminder>' }],
  renderedRole: 'system',
};

/** The notice of a finished background command, which starts a turn of its own. */
export const TASK_NOTICE: RecordEntry = {
  parentUuid: '3a432afb-158c-4fe5-a36e-cd54300a2d52',
  isSidechain: false,
  promptId: '3d9ec827-1d5b-438e-afcb-e2d931078c1e',
  type: 'user',
  message: {
    role: 'user',
    content:
      '<task-notification>\n<task-id>baqmnyz51</task-id>\n<tool-use-id>toolu_013sBHj3Jk443vmoJ8tL599k</tool-use-id>\n<output-file>/tmp/claude-1000/tasks/baqmnyz51.output</output-file>\n<status>completed</status>\n<summary>Background command "Run background sleep and echo" completed (exit code 0)</summary>\n</task-notification>',
  },
  uuid: 'c965e8a6-b09f-4026-bb4e-0c4995d70fe7',
  timestamp: '2026-10-02T16:43:34.129Z',
  origin: { kind: 'task-notification', producer: 'session-task' },
  promptSource: 'system',
  turnOrigin: 'task_notification',
};

export const TASK_NOTICE_REPLY: RecordEntry = {
  parentUuid: 'c965e8a6-b09f-4026-bb4e-0c4995d70fe7',
  isSidechain: false,
  message: { model: 'claude-sonnet-5-5', id: 'msg_011CfdkDgH1Jg4vdezutY9QD', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'The background task finished with exit code 0. It printed `bg-finished`.' }], stop_reason: 'end_turn' },
  apiBlockIndex: 0,
  type: 'assistant',
  uuid: 'ef7de77f-36fd-40a1-bb2b-4f371eeb52de',
  timestamp: '2026-10-02T16:43:35.469Z',
};

export const COMPACT_BOUNDARY: RecordEntry = {
  parentUuid: null,
  logicalParentUuid: '2dde7688-fff7-4af9-ab6b-5220712f1002',
  isSidechain: false,
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  isMeta: false,
  timestamp: '2026-10-02T16:44:29.019Z',
  uuid: 'b20cac5c-f1d1-48ac-b8a3-6bc56039a478',
  level: 'info',
  compactMetadata: {
    trigger: 'manual',
    preTokens: 18557,
    durationMs: 4996,
    preservedSegment: { headUuid: '2dde7688-fff7-4af9-ab6b-5220712f1002', anchorUuid: 'a03a05a6-426e-412b-ab5c-7fb8c6c42737', tailUuid: '2dde7688-fff7-4af9-ab6b-5220712f1002' },
    preservedMessages: { anchorUuid: 'a03a05a6-426e-412b-ab5c-7fb8c6c42737', uuids: ['2dde7688-fff7-4af9-ab6b-5220712f1002'], allUuids: ['2dde7688-fff7-4af9-ab6b-5220712f1002'] },
    postTokens: 2756,
    cumulativeDroppedTokens: 15801,
  },
};

export const COMPACT_SUMMARY: RecordEntry = {
  parentUuid: 'b20cac5c-f1d1-48ac-b8a3-6bc56039a478',
  isSidechain: false,
  promptId: 'b52848b7-f978-4269-b664-9b4bf5865059',
  type: 'user',
  message: {
    role: 'user',
    content:
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   The user is testing short instruction-following.\n\n7. Pending Tasks:\n   None.\n\nContinue the conversation from where it left off without asking the user any further questions.',
  },
  isVisibleInTranscriptOnly: true,
  isCompactSummary: true,
  uuid: 'a03a05a6-426e-412b-ab5c-7fb8c6c42737',
  timestamp: '2026-10-02T16:44:29.018Z',
};

// Entries written by hand in the shape the notes describe, for the kinds no
// recording holds.

/** A subagent's hand-back: a user entry from another session. */
export const SUBAGENT_REPORT: RecordEntry = {
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: '<agent-message from="general-purpose">Review done: 3 findings, none blocking.</agent-message>' },
  isMeta: true,
  origin: { kind: 'peer' },
  uuid: 'c19f4e8a-26b7-4d03-a5e1-7f30b9c8d246',
  timestamp: '2026-10-03T14:22:40.731+10:00',
};

/** The line Claude Code writes when a turn ends. */
export const TURN_DURATION: RecordEntry = {
  isSidechain: false,
  type: 'system',
  subtype: 'turn_duration',
  durationMs: 2000,
  uuid: '9b4e2d70-3a85-4c16-8f07-6d1c0a5e3b92',
  timestamp: '2026-10-03T14:22:44.187+10:00',
};

/** What Claude Code writes under a prompt that was never answered. */
export const NO_RESPONSE: RecordEntry = {
  isSidechain: false,
  message: { model: '<synthetic>', id: 'msg_synthetic_noresponse', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] },
  type: 'assistant',
  uuid: '5d2c8e41-7a93-4b06-9f18-3e0a6c1b7d52',
  timestamp: '2026-10-03T14:30:01.000+10:00',
};

/** What Claude Code writes in place of a reply when the API failed. */
export const API_ERROR: RecordEntry = {
  isSidechain: false,
  message: { model: '<synthetic>', id: 'msg_synthetic_apierror', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary. Try again in a moment.' }] },
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'server_error',
  apiErrorStatus: 529,
  uuid: '7e4a1c93-0b58-4d27-8a6f-2c9d5e3b1f84',
  timestamp: '2026-10-03T14:31:12.500+10:00',
};
