import {
  nativeSystemDiscoveryProvider,
  nativeSystemImplementations,
} from './system-tools';

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

  for (const implementation of nativeSystemImplementations) {
    kernel.registerImplementation(implementation);
  }
}