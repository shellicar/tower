import { createServiceCollection, type IServiceCollection, Lifetime, ResolveMultipleMode } from '@shellicar/core-di';
import { IClaudeCode, SdkClaudeCode } from './ClaudeCode.js';
import { ClaudeCodeSpawner } from './ClaudeCodeSpawner.js';
import { ControlLines } from './ControlLines.js';
import { ConversationLauncher } from './ConversationLauncher.js';
import { ParticipantConfig } from './ParticipantConfig.js';
import { ParticipantSettings } from './ParticipantSettings.js';
import { IProcessSpawner, NodeProcessSpawner } from './ProcessSpawner.js';
import { IPublisher, NullPublisher, PublishingSessionStore } from './SessionStore.js';

/**
 * Every service the participant is made of, one instance each. A later
 * registration for the same token replaces an earlier one, which is how a
 * test puts a fake at a boundary.
 */
export function participantServices(config: ParticipantConfig): IServiceCollection {
  const services = createServiceCollection({ defaultLifetime: Lifetime.Singleton, registrationMode: ResolveMultipleMode.LastRegistered });
  services
    .register(ParticipantConfig)
    .using(() => config)
    .asSelf();
  services.register(ParticipantSettings).asSelf();
  services.register(ControlLines).asSelf();
  services.register(NullPublisher).as(IPublisher);
  services.register(PublishingSessionStore).asSelf();
  services.register(NodeProcessSpawner).as(IProcessSpawner);
  services.register(ClaudeCodeSpawner).asSelf();
  services.register(SdkClaudeCode).as(IClaudeCode);
  services.register(ConversationLauncher).asSelf();
  return services;
}
