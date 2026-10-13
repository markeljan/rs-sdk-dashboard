export interface GatewayFleetSample {
    account: string;
    gatewayUrl: string;
    managed: boolean;
    wanted: boolean;
    observerTransportFailing: boolean;
    gatewayPollFailing: boolean;
    /** Last failure evidence is retained after recovery until evidenceWindowMs expires. */
    observerTransportFailureAt: number;
    gatewayPollFailureAt: number;
}

export interface GatewayOutagePolicyConfig {
    /** Recent failures older than this cannot establish an active shared outage. */
    evidenceWindowMs: number;
    /** Give existing pages time to reconnect and publish after transport returns. */
    recoveryGraceMs: number;
    /** Never classify a single stale client as a fleet outage. */
    minimumAffected: number;
    /** Required share of managed, wanted clients on the same gateway. */
    minimumAffectedFraction: number;
}

export const DEFAULT_GATEWAY_OUTAGE_POLICY: Readonly<GatewayOutagePolicyConfig> = Object.freeze({
    evidenceWindowMs: 45_000,
    recoveryGraceMs: 90_000,
    minimumAffected: 2,
    minimumAffectedFraction: 0.6,
});

export interface GatewayOutageGroupState {
    outageSince: number;
    recoveryGraceUntil: number;
}

export type GatewayOutageState = Record<string, GatewayOutageGroupState>;

export interface GatewayReloadDecision {
    suppressReload: boolean;
    phase: 'normal' | 'shared-outage' | 'recovery-grace';
    affected: number;
    eligible: number;
    outageSince: number | null;
    recoveryGraceUntil: number | null;
}

export interface GatewayOutageEvaluation {
    state: GatewayOutageState;
    decisions: Record<string, GatewayReloadDecision>;
}

const recentFailure = (sample: GatewayFleetSample, now: number, windowMs: number) => {
    if (sample.observerTransportFailing || sample.gatewayPollFailing) return true;
    const latest = Math.max(sample.observerTransportFailureAt, sample.gatewayPollFailureAt);
    return latest > 0 && latest <= now && now - latest <= windowMs;
};

/**
 * Classify only synchronized transport failures. A stale or dead client by itself is deliberately
 * excluded so ManagedClient retains its existing bounded reload/relaunch behavior.
 */
export function evaluateGatewayOutagePolicy(
    previous: Readonly<GatewayOutageState>,
    samples: readonly GatewayFleetSample[],
    now: number,
    config: Readonly<GatewayOutagePolicyConfig> = DEFAULT_GATEWAY_OUTAGE_POLICY,
): GatewayOutageEvaluation {
    const groups = new Map<string, GatewayFleetSample[]>();
    for (const sample of samples) {
        if (!sample.managed || !sample.wanted) continue;
        const members = groups.get(sample.gatewayUrl) ?? [];
        members.push(sample);
        groups.set(sample.gatewayUrl, members);
    }

    const state: GatewayOutageState = {};
    const decisions: Record<string, GatewayReloadDecision> = {};

    for (const [gatewayUrl, members] of groups) {
        const affected = members.filter(sample => recentFailure(sample, now, config.evidenceWindowMs)).length;
        const currentlyFailing = members.filter(sample =>
            sample.observerTransportFailing || sample.gatewayPollFailing).length;
        const eligible = members.length;
        const requiredCount = Math.max(config.minimumAffected, Math.ceil(eligible * config.minimumAffectedFraction));
        // A single managed page is always an isolated-client problem, even if custom config asks for one.
        const recentSharedFailure = eligible >= 2 && affected >= requiredCount;
        const sharedOutage = recentSharedFailure && currentlyFailing >= requiredCount;
        const prior = previous[gatewayUrl];

        let phase: GatewayReloadDecision['phase'] = 'normal';
        let outageSince: number | null = null;
        let recoveryGraceUntil: number | null = null;

        if (sharedOutage) {
            phase = 'shared-outage';
            outageSince = prior?.outageSince || now;
            state[gatewayUrl] = { outageSince, recoveryGraceUntil: 0 };
        } else {
            // Recovery can happen between health ticks. Recent fleet-wide evidence still starts
            // one bounded grace even when this is the first evaluation of the incident.
            const graceUntil = prior?.outageSince || (recentSharedFailure && !prior?.recoveryGraceUntil)
                ? now + config.recoveryGraceMs
                : prior?.recoveryGraceUntil ?? 0;
            if (graceUntil > now) {
                phase = 'recovery-grace';
                recoveryGraceUntil = graceUntil;
                state[gatewayUrl] = { outageSince: 0, recoveryGraceUntil: graceUntil };
            }
        }

        const decision: GatewayReloadDecision = {
            suppressReload: phase !== 'normal',
            phase,
            affected,
            eligible,
            outageSince,
            recoveryGraceUntil,
        };
        for (const member of members) decisions[member.account] = decision;
    }

    return { state, decisions };
}

export function isGatewayTransportFailure(error: string): boolean {
    return /gateway handshake timed out|websocket error|connection closed before the gateway handshake/i.test(error);
}

/** Update a connection signal without discarding the last transport-failure timestamp.
 * A later non-transport failure is current evidence about this connection, so it must clear
 * the sticky `failing` bit while preserving the bounded historical outage evidence. */
export function updateGatewayTransportFailure(
    lastFailureAt: number,
    error: string | null,
    now: number,
): { failing: boolean; lastFailureAt: number } {
    const failing = error !== null && isGatewayTransportFailure(error);
    return { failing, lastFailureAt: failing ? now : lastFailureAt };
}
