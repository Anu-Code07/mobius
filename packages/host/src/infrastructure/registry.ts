// Infrastructure: which devices exist and one session per device. Drivers are discovered through `discover`.
import { MobiusError, type Connector } from '../execution/connector.ts';
import { DeviceSession } from '../execution/session.ts';
import type { AuditLog } from '../observability/audit.ts';
import type { Approver, Policy } from '../policy/policy.ts';
import { newPlaneContext, type PlaneContext } from './plane.ts';

/** Device registry. `discover` is injectable so tests run without real devices. */
export class Mobius {
  private sessions = new Map<string, DeviceSession>();
  private readonly discover: () => Promise<Connector[]>;
  readonly audit: AuditLog;
  readonly policy: Policy;
  readonly approver: Approver;
  /** Real CLI only: keep element ids resolvable across Mobius restarts (identity hashes on disk, never screen text). */
  persistIds = false;

  readonly plane: PlaneContext;

  constructor(discover: () => Promise<Connector[]>, audit: AuditLog, policy: Policy, approver: Approver, plane: PlaneContext = newPlaneContext()) {
    this.plane = plane;
    this.discover = discover;
    this.audit = audit;
    this.policy = policy;
    this.approver = approver;
  }

  async refresh(): Promise<DeviceSession[]> {
    const found = await this.discover();
    const ids = new Set(found.map(c => c.deviceId));
    for (const id of this.sessions.keys()) if (!ids.has(id)) this.sessions.delete(id);
    for (const c of found) if (!this.sessions.has(c.deviceId)) this.sessions.set(c.deviceId, new DeviceSession(c, this.audit, this.policy, this.approver, this.plane, this.persistIds));
    return [...this.sessions.values()];
  }

  async session(deviceId?: string): Promise<DeviceSession> {
    let s = deviceId ? this.sessions.get(deviceId) : undefined;
    if (!s) {
      const all = await this.refresh();
      s = deviceId ? this.sessions.get(deviceId) : all.length === 1 ? all[0] : undefined;
      if (!s) {
        if (deviceId) throw new MobiusError('DEVICE_NOT_FOUND', `No device "${deviceId}"`, { hint: `Available: ${all.map(a => a.connector.deviceId).join(', ') || 'none'}` });
        throw new MobiusError(all.length ? 'INVALID_INPUT' : 'DEVICE_NOT_FOUND',
          all.length ? `${all.length} devices connected; pass device_id` : 'No devices connected',
          { hint: all.length ? `One of: ${all.map(a => a.connector.deviceId).join(', ')}` : 'Start an emulator/simulator or plug in a device, then call device_list.' });
      }
    }
    // A fresh process: read the screen once, so element ids from an earlier process can be resolved right away.
    if (this.persistIds && !s.store.latest()) await s.observe();
    return s;
  }
}
