export * from './types';

export {
  ToolRegistry,
  toolRegistry,
} from './tool-registry';

export {
  ToolDiscovery,
  toolDiscovery,
} from './tool-discovery';

export type {
  DiscoveryProvider,
  DiscoveryResult,
} from './tool-discovery';

export {
  createExecutionContext,
  createKernelId,
} from './execution-context';

export type {
  CreateExecutionContextInput,
} from './execution-context';

export {
  ObservationStore,
  observationStore,
  observationFromActionResult,
} from './observations';

export type {
  CreateObservationInput,
} from './observations';

export {
  AuthorityManager,
  authorityManager,
  defaultAuthorityProfile,
  workspaceAuthorityProfile,
} from './authority';

export type {
  AuthorityDecision,
  AuthorityEvaluation,
  AuthorityProfile,
  AuthorityRule,
} from './authority';

export {
  KernelExecutor,
} from './executor';

export type {
  ExecutorDependencies,
  ToolExecutionInput,
  ToolExecutionOutput,
  ToolImplementation,
} from './executor';

export {
  WorkflowEngine,
} from './workflow';

export type {
  WorkflowExecutionInput,
  WorkflowStepResult,
} from './workflow';

export {
  MARKKernel,
  markKernel,
} from './kernel';

export type {
  KernelDependencies,
  KernelDiscoverySummary,
} from './kernel';

export {
  systemMachineInfoTool,
  systemMachineInfoImplementation,
  systemProcessSummaryTool,
  systemProcessSummaryImplementation,
  fsDirectoryListTool,
  fsDirectoryListImplementation,
  fsFileReadTool,
  fsFileReadImplementation,
  systemProcessListTool,
  systemProcessListImplementation,
  systemDiskUsageTool,
  systemDiskUsageImplementation,
  netNetworkInterfacesTool,
  netNetworkInterfacesImplementation,
  fsDirectoryCreateTool,
  fsDirectoryCreateImplementation,
  fsFileWriteTool,
  fsFileWriteImplementation,
  systemContainerRestartTool,
  systemContainerRestartImplementation,
  systemContainerListTool,
  systemContainerListImplementation,
  fsDirectorySizesTool,
  fsDirectorySizesImplementation,
  containerRestartFamilyImplementation,
  containerRestartTool,
  CONTAINER_RESTART_PREFIX,
  listDockerContainers,
  nativeSystemTools,
  nativeSystemImplementations,
  nativeSystemDiscoveryProvider,
} from './providers/system-tools';

export {
  scanDesktopEntries,
  desktopOpenTool,
  desktopCloseTool,
  desktopListAppsTool,
  desktopListAppsImplementation,
  desktopOpenFamilyImplementation,
  desktopCloseFamilyImplementation,
  desktopDiscoveryProvider,
  DESKTOP_OPEN_PREFIX,
  DESKTOP_CLOSE_PREFIX,
} from './providers/desktop';

export type { DesktopEntry } from './providers/desktop';

export {
  findTracks,
  mediaFindTracksTool,
  mediaFindTracksImplementation,
  mediaExtractTrackTool,
  mediaExtractTrackImplementation,
  mediaNativeTools,
  mediaNativeImplementations,
  mediaDiscoveryProvider,
} from './providers/media';

export { validateOutput } from './output-contracts';

export type { OutputValidationResult } from './output-contracts';

export { scoreCompatibility, resolveSchemaPath, listSchemaLeafPaths } from './compatibility';

export type { CompatibilityScore, SchemaLeafPath } from './compatibility';

export { ConfirmationManager, confirmationManager } from './confirmations';

export type { ConfirmationRecord, ConfirmationStatus } from './confirmations';

export { TrustStore, trustStore } from './trust';

export type { TrustGrant } from './trust';

export { WorkflowMemory, workflowMemory } from './workflow-memory';

export type { LearnedWorkflow, ReusedPlan } from './workflow-memory';

export {
  registerNativeSystemProvider,
} from './providers/register-native';

export {
  MARKKernelBridge,
  markKernelBridge,
} from './bridge';

export {
  CapabilityResolver,
} from './capability-resolver';

export type {
  CapabilityResolution,
  CapabilityResolverDependencies,
  RankedCapability,
} from './capability-resolver';

export {
  GoalExecutor,
} from './goal-execution';

export type {
  GoalExecutionResult,
  GoalExecutionDependencies,
} from './goal-execution';

export {
  TaskBinder,
} from './task-binder';

export type {
  TaskBinding,
  TaskBinderDependencies,
} from './task-binder';

export {
  KernelPlanner,
  Planner,
  validatePlan,
  sortPlanSteps,
} from './planner';

export type {
  PlanStep,
  ExecutionPlan,
  PlanValidationErrorCode,
  PlanValidationError,
  PlanValidationResult,
  PlanExecutionResult,
  PlanStepStatus,
  PlanStepResult,
  PlanExecutionStatus,
  PlanExecutionReport,
  PlannerDependencies,
} from './planner';

export {
  resolveInputReferences,
  isStepReference,
  parseStepReference,
  collectStepReferences,
  StepReferenceError,
} from './step-references';

export type {
  StepReferenceErrorCode,
  StepReferenceTarget,
  StepResultSnapshot,
  StepResultLookup,
} from './step-references';

export {
  executeStructuredPlan,
  toPlanExecutionResult,
} from './plan-execution';

export type {
  ExecuteStructuredPlanInput,
} from './plan-execution';