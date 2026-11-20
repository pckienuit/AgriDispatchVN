import { screens as common } from '../screens/common.js';
import { screens as farmer } from '../screens/farmer.js';
import { screens as provider } from '../screens/provider.js';
import { screens as operator } from '../screens/operator.js';
import { screens as coop } from '../screens/coop.js';
import { screens as admin } from '../screens/admin.js';
import { screens as territories } from '../screens/territories.js';
import { screens as monitoring } from '../screens/local-monitoring.js';

export const registry = new Map();
for (const list of [common, farmer, provider, operator, coop, admin, territories, monitoring]) {
  for (const screen of list) {
    if (registry.has(screen.code)) throw new Error(`Duplicate screen ${screen.code}`);
    registry.set(screen.code, screen);
  }
}
