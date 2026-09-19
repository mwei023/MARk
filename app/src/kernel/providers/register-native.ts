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
  opsVerifyDiscoveryProvider,
  opsVerifyImplementations,
} from './ops-verify';

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
  toolDiscovery.registerProvider(opsVerifyDiscoveryProvider);

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

  for (const implementation of opsVerifyImplementations) {
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
