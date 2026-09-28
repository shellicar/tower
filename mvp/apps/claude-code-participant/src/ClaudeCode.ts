import { type Options, type Query, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Claude Code through the Agent SDK. An abstract class so tests can see the
 * options a conversation is launched with, without starting Claude Code.
 */
export abstract class IClaudeCode {
  public abstract query(prompt: AsyncIterable<SDKUserMessage>, options: Options): Query;
}

export class SdkClaudeCode implements IClaudeCode {
  public query(prompt: AsyncIterable<SDKUserMessage>, options: Options): Query {
    return query({ prompt, options });
  }
}
