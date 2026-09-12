/** P1.1–P1.3 — Agent core (pure, testable, framework-agnostic). */
export { agentLoop } from './loop';
export { Agent } from './agent';
export { createPersistenceSubscriber } from './persistence-subscriber';
export type * from './types';
export type { AgentSubscriber } from './agent';
export type { PersistenceSubscriberOptions } from './persistence-subscriber';