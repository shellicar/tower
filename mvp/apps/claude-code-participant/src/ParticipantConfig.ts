import type { Startup } from './startup.js';

/** Everything fixed for the process's life, decided once at start. */
export class ParticipantConfig {
  public readonly natsUrl: string;
  public readonly configDir: string;
  public readonly realHome: string;
  public readonly inheritedEnv: Readonly<Record<string, string>>;
  /** Claude Code's machinery gets this as HOME: one per process, never removed. */
  public readonly privateHome: string;
  /** setpriv's path, or null when it isn't on PATH. */
  public readonly setpriv: string | null;
  /** The script that gives commands Claude Code runs the real HOME back. */
  public readonly shellPrefix: string;

  public constructor(startup: Startup, privateHome: string, setpriv: string | null, shellPrefix: string) {
    this.natsUrl = startup.natsUrl;
    this.configDir = startup.configDir;
    this.realHome = startup.realHome;
    this.inheritedEnv = startup.inheritedEnv;
    this.privateHome = privateHome;
    this.setpriv = setpriv;
    this.shellPrefix = shellPrefix;
  }
}
