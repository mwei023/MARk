import { markKernel } from '../kernel';
import { toolDiscovery } from '../tool-discovery';

import {
  nativeSystemDiscoveryProvider,
  nativeSystemImplementations,
} from './system-tools';

export function registerNativeSystemProvider(): void {
  toolDiscovery.registerProvider(nativeSystemDiscoveryProvider);

  for (const implementation of nativeSystemImplementations) {
    markKernel.registerImplementation(implementation);
  }
}
