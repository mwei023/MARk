import {
  nativeSystemDiscoveryProvider,
  nativeSystemImplementations,
  containerRestartFamilyImplementation,
  CONTAINER_RESTART_PREFIX,
} from './system-tools';

import {
  desktopDiscoveryProvider,
  desktopListAppsImplementation,
  desktopOpenFamilyImplementation,
  desktopCloseFamilyImplementation,
  DESKTOP_OPEN_PREFIX,
  DESKTOP_CLOSE_PREFIX,
} from './desktop';

import {
  mediaDiscoveryProvider,
  mediaNativeImplementations,
} from './media';

import {
  incidentDiscoveryProvider,
  incidentImplementations,
} from './incidents';

import {
  browserDiscoveryProvider,
  browserNativeImplementations,
} from './browser';

import {
  investigateDiscoveryProvider,
  investigateImplementations,
} from './investigate';

import {
  screenDiscoveryProvider,
  screenImplementations,
} from './screen';

import {
  repoSemanticDiscoveryProvider,
  repoSemanticImplementations,
} from './repo-semantic';

import {
  gitDeployDiscoveryProvider,
  gitDeployImplementations,
} from './git-deploy';

import {
  worldPerceptionDiscoveryProvider,
  worldPerceptionImplementations,
} from './world-perception';

import {
  sysSandboxDiscoveryProvider,
  sysSandboxImplementations,
} from './sys-sandbox';

import {
  opsVerifyDiscoveryProvider,
  opsVerifyImplementations,
} from './ops-verify';

import {
  skillInstallDiscoveryProvider,
  skillImplementations,
} from './skill-install';

import {
  githubDiscoveryProvider,
  githubImplementations,
} from './github';

import {
  kbDiscoveryProvider,
  kbImplementations,
} from './kb';

import {
  assistantDiscoveryProvider,
  assistantImplementations,
} from './assistant';

import {
  emailDiscoveryProvider,
  emailImplementations,
} from './email';

import {
  lspDiscoveryProvider,
  lspImplementations,
} from './lsp';

import {
  MARKKernel,
  markKernel,
} from '../kernel';

import {
  toolDiscovery,
} from '../tool-discovery';

export function registerNativeSystemProvider(
  kernel: MARKKernel = markKernel,
): void {
  toolDiscovery.registerProvider(nativeSystemDiscoveryProvider);
  toolDiscovery.registerProvider(desktopDiscoveryProvider);
  toolDiscovery.registerProvider(mediaDiscoveryProvider);
  toolDiscovery.registerProvider(incidentDiscoveryProvider);
  toolDiscovery.registerProvider(browserDiscoveryProvider);
  toolDiscovery.registerProvider(investigateDiscoveryProvider);
  toolDiscovery.registerProvider(screenDiscoveryProvider);
  toolDiscovery.registerProvider(repoSemanticDiscoveryProvider);
  toolDiscovery.registerProvider(gitDeployDiscoveryProvider);
  toolDiscovery.registerProvider(worldPerceptionDiscoveryProvider);
  toolDiscovery.registerProvider(sysSandboxDiscoveryProvider);
  toolDiscovery.registerProvider(opsVerifyDiscoveryProvider);
  toolDiscovery.registerProvider(skillInstallDiscoveryProvider);
  toolDiscovery.registerProvider(githubDiscoveryProvider);
  toolDiscovery.registerProvider(kbDiscoveryProvider);
  toolDiscovery.registerProvider(assistantDiscoveryProvider);
  toolDiscovery.registerProvider(emailDiscoveryProvider);
  toolDiscovery.registerProvider(lspDiscoveryProvider);

  for (const implementation of nativeSystemImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of mediaNativeImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of incidentImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of browserNativeImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of investigateImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of screenImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of repoSemanticImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of gitDeployImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of worldPerceptionImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of sysSandboxImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of opsVerifyImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of skillImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of githubImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of kbImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of assistantImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of emailImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of lspImplementations) {
    kernel.registerImplementation(implementation);
  }

  kernel.registerImplementation(desktopListAppsImplementation);

  kernel.executor.registerFamilyImplementation(
    CONTAINER_RESTART_PREFIX,
    containerRestartFamilyImplementation,
  );
  kernel.executor.registerFamilyImplementation(
    DESKTOP_OPEN_PREFIX,
    desktopOpenFamilyImplementation,
  );
  kernel.executor.registerFamilyImplementation(
    DESKTOP_CLOSE_PREFIX,
    desktopCloseFamilyImplementation,
  );
}
