/**
 * Event types for Mark's autonomous operations system.
 * All events flow through the event bus and are routed to appropriate agents.
 */

/**
 * Base event structure - all events conform to this
 */
export interface BaseEvent {
  id: string;
  timestamp: Date;
  source: EventSource;
  type: EventType;
  severity: 'info' | 'warning' | 'critical';
  data: Record<string, any>;
  correlationId?: string; // Links related events together
}

export type EventSource =
  | 'github'
  | 'docker'
  | 'ci_pipeline'
  | 'health_check'
  | 'user_command'
  | 'api'
  | 'voice'
  | 'system'
  | 'market';

export type EventType =
  // GitHub / Git
  | 'github.push'
  | 'github.pull_request.opened'
  | 'github.pull_request.merged'
  | 'github.workflow.started'
  | 'github.workflow.completed'
  | 'github.workflow.failed'
  | 'github.deployment.started'
  | 'github.deployment.succeeded'
  | 'github.deployment.failed'
  | 'github.issue.opened'
  
  // Docker / Services
  | 'docker.container.exited'
  | 'docker.container.health_status.unhealthy'
  | 'docker.service.restarted'
  
  // CI/CD
  | 'ci.test.failed'
  | 'ci.lint.failed'
  | 'ci.build.failed'
  | 'ci.deploy.rejected'
  
  // System
  | 'system.disk.high'
  | 'system.memory.high'
  | 'system.cpu.high'
  | 'system.process.high'
  | 'system.service.down'
  | 'system.health.check'
  
  // Market
  | 'market.snapshot.requested'
  | 'market.alert.triggered'
  | 'market.watchlist.triggered'
  | 'market.holdings.snapshot'
  
  // User
  | 'user.command.received'
  | 'user.approval.requested'
  | 'user.approval.granted'
  | 'user.approval.denied'
  
  // Internal
  | 'incident.created'
  | 'incident.updated'
  | 'incident.resolved'
  | 'agent.action.taken'
  | 'agent.action.failed'

  // Code repair (coding agent)
  | 'code.repair.requested'
  | 'code.repair.completed'

  // Screen tasks (computer-use agent)
  | 'screen.task.requested'
  | 'screen.task.completed';

/**
 * Specific event implementations
 */

export interface GitHubWorkflowFailedEvent extends BaseEvent {
  type: 'github.workflow.failed';
  data: {
    repository: string;
    workflowName: string;
    commit: string;
    branch: string;
    runId: string;
    conclusion: string; // 'failure', 'timed_out', etc
    jobsUrl: string;
    logsUrl?: string;
  };
}

export interface GitHubDeploymentFailedEvent extends BaseEvent {
  type: 'github.deployment.failed';
  data: {
    repository: string;
    environment: string;
    commit: string;
    deploymentId: string;
    reason?: string;
    previousVersionHealthy?: boolean;
  };
}

export interface DockerHealthFailedEvent extends BaseEvent {
  type: 'docker.container.health_status.unhealthy';
  data: {
    containerId: string;
    containerName: string;
    service: string;
    lastHealthStatus: string;
    timestamp: Date;
  };
}

export interface UserCommandEvent extends BaseEvent {
  type: 'user.command.received';
  data: {
    userId: string;
    command: string;
    source: 'voice' | 'api' | 'cli';
    metadata?: Record<string, any>;
  };
}

export interface IncidentCreatedEvent extends BaseEvent {
  type: 'incident.created';
  data: {
    incidentId: string;
    title: string;
    description: string;
    assignedAgent: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
  };
}

// Union type for all events
export type Event =
  | GitHubWorkflowFailedEvent
  | GitHubDeploymentFailedEvent
  | DockerHealthFailedEvent
  | UserCommandEvent
  | IncidentCreatedEvent
  | BaseEvent;
