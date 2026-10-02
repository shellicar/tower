import { createServiceCollection, type IServiceCollection, Lifetime, ResolveMultipleMode } from '@shellicar/core-di';
import { IBroker, NatsBroker } from './Broker.js';
import { IClaudeCode, SdkClaudeCode } from './ClaudeCode.js';
import { ClaudeCodeSpawner } from './ClaudeCodeSpawner.js';
import { ControlLines } from './ControlLines.js';
import { ConversationLauncher } from './ConversationLauncher.js';
import { Conversations } from './Conversations.js';
import { IHost, NodeHost } from './Host.js';
import { IIds, RandomIds } from './Ids.js';
import { Leftovers } from './Leftovers.js';
import { ParticipantConfig } from './ParticipantConfig.js';
import { ParticipantLock } from './ParticipantLock.js';
import { ParticipantSettings } from './ParticipantSettings.js';
import { Presence } from './Presence.js';
import { IProcessSpawner, NodeProcessSpawner } from './ProcessSpawner.js';
import { IProcessTable, LinuxProcessTable, MacProcessTable, realPs } from './ProcessTable.js';
import { IPublishedHistory, NatsPublishedHistory } from './PublishedHistory.js';
import { ServingGate } from './ServingGate.js';
import { BusPublisher, IPublisher, ISessionLoader, LocalRecordLoader, PublishingSessionStore } from './SessionStore.js';
import { Shutdown } from './Shutdown.js';
import { ITimer, RealTimer } from './Timer.js';

/**
 * Every service the participant is made of, one instance each. A later
 * registration for the same token replaces an earlier one, which is how a
 * test puts a fake at a boundary. The process table is the one for
 * `platform`.
 */
export function participantServices(config: ParticipantConfig, platform: NodeJS.Platform): IServiceCollection {
  const services = createServiceCollection({ defaultLifetime: Lifetime.Singleton, registrationMode: ResolveMultipleMode.LastRegistered });
  services
    .register(ParticipantConfig)
    .using(() => config)
    .asSelf();
  services.register(ParticipantSettings).asSelf();
  services.register(ControlLines).asSelf();
  services.register(BusPublisher).as(IPublisher);
  services.register(LocalRecordLoader).as(ISessionLoader);
  services.register(NatsPublishedHistory).as(IPublishedHistory);
  services.register(PublishingSessionStore).asSelf();
  services.register(NodeProcessSpawner).as(IProcessSpawner);
  services.register(ClaudeCodeSpawner).asSelf();
  services.register(SdkClaudeCode).as(IClaudeCode);
  services.register(Conversations).asSelf();
  services.register(ConversationLauncher).asSelf();
  if (platform === 'darwin') {
    services
      .register(MacProcessTable)
      .using(() => new MacProcessTable(realPs, (pid, signal) => process.kill(pid, signal), process.pid))
      .as(IProcessTable);
  } else {
    services
      .register(LinuxProcessTable)
      .using(() => new LinuxProcessTable('/proc', (pid, signal) => process.kill(pid, signal), process.pid))
      .as(IProcessTable);
  }
  services.register(RealTimer).as(ITimer);
  services.register(ParticipantLock).asSelf();
  services.register(Leftovers).asSelf();
  services.register(ServingGate).asSelf();
  services.register(NodeHost).as(IHost);
  services.register(NatsBroker).as(IBroker);
  services.register(RandomIds).as(IIds);
  services.register(Presence).asSelf();
  services.register(Shutdown).asSelf();
  return services;
}
