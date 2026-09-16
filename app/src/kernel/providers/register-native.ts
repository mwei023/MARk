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

  for (const implementation of nativeSystemImplementations) {
    kernel.registerImplementation(implementation);
  }

  for (const implementation of mediaNativeImplementations) {
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
