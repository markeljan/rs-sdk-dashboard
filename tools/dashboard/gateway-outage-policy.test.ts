import { describe, expect, test } from 'bun:test';
import {
    evaluateGatewayOutagePolicy,
    isGatewayTransportFailure,
    updateGatewayTransportFailure,
    type GatewayFleetSample,
    type GatewayOutageState,
} from './gateway-outage-policy';

const NOW = 1_000_000;
const gateway = 'wss://rs-sdk-demo.fly.dev/gateway';
const sample = (account: string, failureAt = 0, gatewayUrl = gateway): GatewayFleetSample => ({
    account,
    gatewayUrl,
    managed: true,
    wanted: true,
    observerTransportFailing: failureAt > 0,
    gatewayPollFailing: false,
    observerTransportFailureAt: failureAt,
    gatewayPollFailureAt: 0,
});

describe('gateway outage reload policy', () => {
    test('an isolated stale client retains normal reload eligibility', () => {
        const result = evaluateGatewayOutagePolicy({}, [sample('SOKO', NOW)], NOW);
        expect(result.decisions.SOKO).toEqual({
            suppressReload: false,
            phase: 'normal',
            affected: 1,
            eligible: 1,
            outageSince: null,
            recoveryGraceUntil: null,
        });
        expect(result.state).toEqual({});
    });

    test('one failing account among a healthy fleet remains an isolated-client problem', () => {
        const samples = Array.from({ length: 13 }, (_, index) => sample(index === 0 ? 'SOKO' : `alt-${index}`, index === 0 ? NOW : 0));
        const result = evaluateGatewayOutagePolicy({}, samples, NOW);
        expect(result.decisions.SOKO?.phase).toBe('normal');
        expect(result.decisions.SOKO?.affected).toBe(1);
        expect(result.decisions.SOKO?.eligible).toBe(13);
    });

    test('a fleet-wide failure suppresses reload only for the affected gateway', () => {
        const samples = [
            sample('SOKO', NOW - 1_000),
            sample('partner', NOW - 2_000),
            sample('alt', NOW - 3_000),
            sample('healthy-on-same-gateway'),
            sample('local-one', NOW - 1_000, 'ws://localhost:7780'),
        ];
        const result = evaluateGatewayOutagePolicy({}, samples, NOW);

        expect(result.decisions.SOKO?.phase).toBe('shared-outage');
        expect(result.decisions.partner?.suppressReload).toBe(true);
        expect(result.decisions.alt?.affected).toBe(3);
        expect(result.decisions.alt?.eligible).toBe(4);
        expect(result.decisions['healthy-on-same-gateway']?.suppressReload).toBe(true);
        expect(result.decisions['local-one']?.phase).toBe('normal');
    });

    test('a shared HTTP status transport failure uses the same bounded policy', () => {
        const samples = ['SOKO', 'partner'].map(account => ({
            ...sample(account),
            gatewayPollFailing: true,
            gatewayPollFailureAt: NOW,
        }));
        const result = evaluateGatewayOutagePolicy({}, samples, NOW);
        expect(result.decisions.SOKO?.phase).toBe('shared-outage');
        expect(result.decisions.partner?.affected).toBe(2);
    });

    test('transport recovery starts one bounded grace without extending it on every evaluation', () => {
        const outage = evaluateGatewayOutagePolicy({}, [sample('SOKO', NOW), sample('partner', NOW)], NOW);
        const recoveredAt = NOW + 10_000;
        const recoveredSamples = [sample('SOKO', NOW), sample('partner', NOW)]
            .map(entry => ({ ...entry, observerTransportFailing: false }));
        const grace = evaluateGatewayOutagePolicy(outage.state, recoveredSamples, recoveredAt);

        expect(grace.decisions.SOKO?.phase).toBe('recovery-grace');
        expect(grace.decisions.SOKO?.recoveryGraceUntil).toBe(recoveredAt + 90_000);

        const later = evaluateGatewayOutagePolicy(grace.state, recoveredSamples, recoveredAt + 30_000);
        expect(later.decisions.SOKO?.recoveryGraceUntil).toBe(recoveredAt + 90_000);

        const expired = evaluateGatewayOutagePolicy(later.state, recoveredSamples, recoveredAt + 90_000);
        expect(expired.decisions.SOKO?.phase).toBe('normal');
        expect(expired.state).toEqual({});
    });

    test('the observed thirteen-client outage suppresses the synchronized reload after transport returns', () => {
        const accounts = ['SOKO', 'partner', ...Array.from({ length: 11 }, (_, index) => `fleet-${index}`)];
        const failedAt = NOW;
        const outage = evaluateGatewayOutagePolicy({}, accounts.map(account => sample(account, failedAt)), failedAt + 10_000);
        expect(outage.decisions.SOKO?.affected).toBe(13);
        expect(outage.decisions.SOKO?.phase).toBe('shared-outage');

        const transportReturnedAt = failedAt + 24_000;
        const recoveredSamples = accounts.map(account => ({
            ...sample(account, failedAt), observerTransportFailing: false,
        }));
        const recovered = evaluateGatewayOutagePolicy(outage.state, recoveredSamples, transportReturnedAt);
        const oldReloadTime = failedAt + 44_000;
        const beforeOldReload = evaluateGatewayOutagePolicy(recovered.state, recoveredSamples, oldReloadTime);
        expect(beforeOldReload.decisions.SOKO?.phase).toBe('recovery-grace');
        expect(beforeOldReload.decisions.partner?.suppressReload).toBe(true);

        const afterGrace = evaluateGatewayOutagePolicy(beforeOldReload.state, recoveredSamples, transportReturnedAt + 90_000);
        expect(afterGrace.decisions.SOKO?.phase).toBe('normal');
    });

    test('recovery before the first health evaluation still suppresses the old synchronized reload window', () => {
        const recoveredBeforeEvaluation = Array.from({ length: 13 }, (_, index) => ({
            ...sample(index === 0 ? 'SOKO' : `fleet-${index}`, NOW - 15_000),
            observerTransportFailing: false,
        }));
        const first = evaluateGatewayOutagePolicy({}, recoveredBeforeEvaluation, NOW);
        expect(first.decisions.SOKO?.phase).toBe('recovery-grace');
        expect(first.decisions.SOKO?.affected).toBe(13);
        expect(first.decisions.SOKO?.suppressReload).toBe(true);
        expect(first.decisions.SOKO?.recoveryGraceUntil).toBe(NOW + 90_000);

        const atOldReload = evaluateGatewayOutagePolicy(first.state,
            recoveredBeforeEvaluation, NOW + 20_000);
        expect(atOldReload.decisions.SOKO?.phase).toBe('recovery-grace');
        expect(atOldReload.decisions.SOKO?.recoveryGraceUntil).toBe(NOW + 90_000);
    });

    test('a renewed shared failure during grace returns to outage and starts a fresh later grace', () => {
        const prior: GatewayOutageState = { [gateway]: { outageSince: 0, recoveryGraceUntil: NOW + 60_000 } };
        const resumed = evaluateGatewayOutagePolicy(prior, [sample('SOKO', NOW), sample('partner', NOW)], NOW);
        expect(resumed.decisions.SOKO?.phase).toBe('shared-outage');
        expect(resumed.state[gateway]?.recoveryGraceUntil).toBe(0);

        const recovered = evaluateGatewayOutagePolicy(resumed.state, [sample('SOKO'), sample('partner')], NOW + 20_000);
        expect(recovered.decisions.SOKO?.recoveryGraceUntil).toBe(NOW + 110_000);
    });

    test('expired transport evidence cannot mask dead clients indefinitely', () => {
        const staleEvidence = NOW - 45_001;
        const samples = [sample('SOKO', staleEvidence), sample('partner', staleEvidence)]
            .map(entry => ({ ...entry, observerTransportFailing: false }));
        const result = evaluateGatewayOutagePolicy({}, samples, NOW);
        expect(result.decisions.SOKO?.phase).toBe('normal');
        expect(result.decisions.partner?.suppressReload).toBe(false);
    });

    test('stopped clients do not dilute or establish a fleet outage', () => {
        const stopped = { ...sample('stopped', NOW), wanted: false };
        const lite = { ...sample('lite', NOW), managed: false };
        const result = evaluateGatewayOutagePolicy({}, [sample('SOKO', NOW), stopped, lite], NOW);
        expect(result.decisions.SOKO?.phase).toBe('normal');
        expect(result.decisions.stopped).toBeUndefined();
        expect(result.decisions.lite).toBeUndefined();
    });
});

test('only transport failures participate in the shared-outage signal', () => {
    expect(isGatewayTransportFailure('Gateway handshake timed out after 20000ms')).toBe(true);
    expect(isGatewayTransportFailure('Connection closed before the gateway handshake completed')).toBe(true);
    expect(isGatewayTransportFailure('WebSocket error')).toBe(true);
    expect(isGatewayTransportFailure('Authentication failed: invalid password')).toBe(false);
    expect(isGatewayTransportFailure('Game state not ready')).toBe(false);
});

test('a later non-transport observer failure clears current outage without erasing recent evidence', () => {
    const transport = updateGatewayTransportFailure(0,
        'Gateway handshake timed out after 20000ms', NOW);
    expect(transport).toEqual({ failing: true, lastFailureAt: NOW });

    const auth = updateGatewayTransportFailure(transport.lastFailureAt,
        'Authentication failed: invalid password', NOW + 15_000);
    expect(auth).toEqual({ failing: false, lastFailureAt: NOW });

    const recovered = updateGatewayTransportFailure(auth.lastFailureAt, null, NOW + 20_000);
    expect(recovered).toEqual({ failing: false, lastFailureAt: NOW });
});
