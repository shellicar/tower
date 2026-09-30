/**
 * Every way the participant exits, one code each, so whatever started it can
 * tell them apart. 0 is success, as everywhere. The rest sit in 64 to 113:
 * below 15 are Node's own codes, 126 and 127 are the shell's, and 128 and up
 * mean killed by a signal.
 */
export const EXITS = {
  clean: { code: 0, meaning: 'shutdown finished its first stage: everything the participant started has stopped' },
  forced: { code: 64, meaning: 'shutdown finished its second stage: whatever was still running was killed' },
  instant: { code: 65, meaning: 'shutdown reached its third stage and exited at once, whatever was still running' },
  badEnvironment: { code: 66, meaning: 'an environment value it starts from is missing or unusable' },
  configDirLocked: { code: 67, meaning: 'another participant is running on the config dir' },
  unsupportedPlatform: { code: 68, meaning: "the platform isn't one it runs on" },
} as const;

export type ExitName = keyof typeof EXITS;
