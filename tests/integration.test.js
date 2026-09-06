'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHarness } = require('./browser-harness.js');

function close(actual, expected, tolerance, message) {
    assert.ok(Math.abs(actual - expected) <= tolerance,
        `${message}: expected ${expected}, got ${actual}`);
}

function runAtSpeed(speed, options = {}) {
    const durationSeconds = options.durationSeconds || 1;
    const disturbance = options.disturbance || 'none';
    const harness = createHarness();
    harness.run(`
        state.scenario = 'baseline';
        init('uk');
        normalRandom = () => 0;
        setDisturbance('${disturbance}');
        state.speed = ${speed};
        state.running = true;
        state.lastFrameTimestamp = 0;
        state.stepAccumulator = 0;
        globalThis.stepSizes = [];
        const unwrappedPhysicsStep = physicsStep;
        physicsStep = dt => {
            stepSizes.push(dt);
            return unwrappedPhysicsStep(dt);
        };
    `);
    harness.run('step(0)');
    const wallStepMs = 250 / speed;
    const frameCount = durationSeconds * 4;
    for (let frame = 1; frame <= frameCount; frame++) {
        harness.run(`step(${frame * wallStepMs})`);
    }
    harness.run('state.running = false');
    return JSON.parse(harness.run(`JSON.stringify({
        stepSizes,
        time: state.time,
        frequency: state.freq,
        totalGen: state.lastTotalGen,
        totalLoad: state.display.totalLoad,
        inertia: state.currentInertiaGvas,
        systemState: state.systemState,
        nodeValues: state.nodes.map(node => node.val)
    })`));
}

test('speed changes wall clock scheduling without changing physics', () => {
    const normal = runAtSpeed(50);
    const fast = runAtSpeed(300);

    assert.ok(normal.stepSizes.length > 0, 'normal speed advances the model');
    assert.ok(fast.stepSizes.length > 0, 'fast speed advances the model');
    assert.ok(normal.stepSizes.every(dt => dt === 0.1), 'normal speed uses the physical timestep');
    assert.ok(fast.stepSizes.every(dt => dt === 0.1), 'fast speed uses the physical timestep');
    close(fast.time, normal.time, 1e-9, 'equal simulated duration');
    close(fast.frequency, normal.frequency, 1e-12, 'frequency is speed invariant');
    close(fast.totalGen, normal.totalGen, 1e-9, 'generation is speed invariant');
    assert.deepEqual(fast.nodeValues, normal.nodeValues, 'node outputs are speed invariant');
});

test('speed is invariant through a 60 second demand surge', () => {
    const normal = runAtSpeed(50, { durationSeconds: 60, disturbance: 'load_surge' });
    const fast = runAtSpeed(300, { durationSeconds: 60, disturbance: 'load_surge' });

    assert.equal(normal.stepSizes.length, 600);
    assert.equal(fast.stepSizes.length, 600);
    assert.deepEqual(fast.stepSizes, normal.stepSizes);
    close(fast.time, normal.time, 1e-9, 'equal simulated duration');
    close(fast.frequency, normal.frequency, 1e-12, 'frequency is speed invariant');
    close(fast.totalGen, normal.totalGen, 1e-9, 'generation is speed invariant');
    close(fast.totalLoad, normal.totalLoad, 1e-9, 'demand is speed invariant');
    close(fast.inertia, normal.inertia, 1e-12, 'inertia is speed invariant');
    assert.equal(fast.systemState, normal.systemState);
    assert.deepEqual(fast.nodeValues, normal.nodeValues, 'node outputs are speed invariant');
});

test('the frame cap preserves a high speed simulation backlog', () => {
    const harness = createHarness();
    const result = JSON.parse(harness.run(`
        init('uk');
        state.speed = 1800;
        state.running = true;
        state.lastFrameTimestamp = 0;
        state.stepAccumulator = 0;
        let stepCount = 0;
        physicsStep = dt => {
            stepCount++;
            state.time += dt;
        };
        step(250);
        const firstFrame = { stepCount, accumulator: state.stepAccumulator };
        for (let frame = 0; frame < 20 && state.stepAccumulator >= state.dt; frame++) {
            step(250);
        }
        state.running = false;
        JSON.stringify({
            firstFrame,
            stepCount,
            accumulator: state.stepAccumulator,
            accountedSeconds: stepCount * state.dt + state.stepAccumulator
        });
    `));

    assert.equal(result.firstFrame.stepCount, 400, 'one frame respects the work cap');
    assert.ok(result.firstFrame.accumulator > 400, 'unprocessed simulation time remains queued');
    close(result.accountedSeconds, 450, 1e-6, 'all requested simulation time is conserved');
    close(result.accumulator, 0, 1e-6, 'later frames drain the backlog');
});

test('zero dispatch and zero online capacity keep a generator offline', () => {
    const harness = createHarness();
    const result = JSON.parse(harness.run(`
        init('uk');
        normalRandom = () => 0;
        const generator = state.nodes.find(node => node.type === 'conv' && node.fuel === 'gas');
        state.dispatchSetpoints[generator.id] = 0;
        generator.onlineCap = 0;
        generator.val = 0;
        generator.p = 0;
        state.governors[generator.id].init(0);
        state.dispatchInterval = Infinity;
        state.lastDispatchTime = state.time;
        physicsStep(0.1);
        JSON.stringify({
            output: generator.val,
            target: generator.pSetpoint,
            onlineCap: generator.onlineCap
        });
    `));

    assert.equal(result.onlineCap, 0);
    assert.equal(result.target, 0);
    assert.equal(result.output, 0);
});

test('changing grid clears the selected and armed disturbance', () => {
    const harness = createHarness();
    harness.run("init('uk'); setDisturbance('gen_trip')");
    assert.equal(harness.element('distSelect').value, 'gen_trip');
    assert.equal(harness.element('distSelect').classList.contains('armed'), true);

    harness.run("setGrid('morocco')");

    assert.equal(harness.run('state.disturbance'), 'none');
    assert.equal(harness.element('distSelect').value, 'none');
    assert.equal(harness.element('distSelect').classList.contains('armed'), false);
});

test('a generator contingency changes node capacity and keeps the generation ledger closed', () => {
    const harness = createHarness();
    const result = JSON.parse(harness.run(`
        init('uk');
        normalRandom = () => 0;
        state.dispatchInterval = Infinity;
        const conventional = () => state.nodes.filter(node => node.type === 'conv');
        const onlineCapacity = () => conventional().reduce(
            (sum, node) => sum + Math.max(0, node.onlineCap === undefined ? node.cap : node.onlineCap), 0
        );
        const nameplate = conventional().reduce((sum, node) => sum + node.cap, 0);
        const beforeOnline = onlineCapacity();
        setDisturbance('gen_trip');
        physicsStep(0.1);
        const nodeGeneration = state.nodes
            .filter(node => node.type !== 'load')
            .reduce((sum, node) => sum + (node.val || 0), 0);
        JSON.stringify({
            beforeOnline,
            afterOnline: onlineCapacity(),
            beforeNameplate: nameplate,
            afterNameplate: conventional().reduce((sum, node) => sum + node.cap, 0),
            nodeGeneration,
            totalGen: state.lastTotalGen
        });
    `));

    assert.ok(result.afterOnline < result.beforeOnline,
        'credible loss reduces available conventional capacity');
    close(result.nodeGeneration, result.totalGen, 1e-9,
        'reported generation equals the node ledger');
    assert.equal(result.afterNameplate, result.beforeNameplate,
        'a contingency does not rewrite installed nameplate capacity');
});

test('periodic dispatch cannot restore capacity lost in a contingency', () => {
    const harness = createHarness();
    const result = JSON.parse(harness.run(`JSON.stringify((() => {
        init('uk');
        normalRandom = () => 0;
        setDisturbance('gen_trip');
        physicsStep(0.1);
        const conventional = () => state.nodes.filter(node => node.type === 'conv');
        const sum = key => conventional().reduce((total, node) => total + node[key], 0);
        const afterTrip = {
            onlineCap: sum('onlineCap'),
            lostCap: sum('lostCap'),
            dispatchTime: state.lastDispatchTime
        };
        for (let tick = 1; tick < 1250 && state.systemState === 'operational'; tick++) {
            physicsStep(0.1);
        }
        return {
            afterTrip,
            afterDispatch: {
                onlineCap: sum('onlineCap'),
                lostCap: sum('lostCap'),
                dispatchTime: state.lastDispatchTime
            },
            systemState: state.systemState
        };
    })())`));

    assert.equal(result.systemState, 'operational');
    assert.ok(result.afterDispatch.dispatchTime > result.afterTrip.dispatchTime,
        'the scenario crosses a dispatch boundary');
    close(result.afterDispatch.onlineCap, result.afterTrip.onlineCap, 1e-9,
        'dispatch preserves post contingency online capacity');
    close(result.afterDispatch.lostCap, result.afterTrip.lostCap, 1e-9,
        'dispatch preserves unavailable capacity');
});

test('reported inertia is the inertia of the committed fleet', () => {
    const harness = createHarness();
    const result = JSON.parse(harness.run(`
        state.scenario = 'optimized';
        init('uk');
        const inertiaSeconds = { nuclear: 5, gas: 4, coal: 4, hydro: 3 };
        const actualGvaSeconds = state.nodes
            .filter(node => node.type === 'conv' && !node.tripped)
            .reduce((sum, node) => {
                const online = node.onlineCap === undefined ? node.cap : node.onlineCap;
                return sum + (inertiaSeconds[node.fuel] || 4) * Math.max(0, online) / 1000;
            }, 0);
        JSON.stringify({
            actualGvaSeconds,
            reportedGvaSeconds: state.currentInertiaGvas,
            reportedH: state.currentH,
            baseMVA: state.grid.baseMVA,
            targetGvaSeconds: BENCHMARKS.uk.minimumInertia
        });
    `));

    assert.ok(result.actualGvaSeconds < result.targetGvaSeconds,
        'the optimized UK fleet cannot meet the inertia target');
    close(result.reportedGvaSeconds, result.actualGvaSeconds, 1e-9,
        'reported inertia contains no synthetic floor');
    close(result.reportedH, result.actualGvaSeconds * 1000 / result.baseMVA, 1e-12,
        'reported inertia constant uses committed inertia');
});

test('every grid, mode, and disturbance keeps finite physical ledgers', () => {
    const disturbances = [
        'gen_trip', 'double_trip', 're_collapse',
        'load_surge', 'ic_loss', 'cascade'
    ];
    for (const grid of ['morocco', 'uk']) {
        for (const scenario of ['baseline', 'optimized']) {
            const harness = createHarness();
            for (const disturbance of disturbances) {
                const result = JSON.parse(harness.run(`JSON.stringify((() => {
                    state.scenario = '${scenario}';
                    init('${grid}');
                    normalRandom = () => 0;
                    setDisturbance('${disturbance}');
                    const inertiaSeconds = { nuclear: 5, gas: 4, coal: 4, hydro: 3 };
                    let issue = null;
                    for (let tick = 0; tick < 600 && !issue; tick++) {
                        physicsStep(0.1);
                        const nodeGeneration = state.nodes
                            .filter(node => node.type !== 'load')
                            .reduce((sum, node) => sum + (node.val || 0), 0);
                        const actualInertia = state.nodes
                            .filter(node => node.type === 'conv' && !node.tripped)
                            .reduce((sum, node) => {
                                const online = node.onlineCap === undefined ? node.cap : node.onlineCap;
                                return sum + (inertiaSeconds[node.fuel] || 4) * Math.max(0, online) / 1000;
                            }, 0);
                        const finiteValues = [
                            state.freq, state.rocof, state.lastTotalGen,
                            state.currentH, state.currentInertiaGvas,
                            ...state.nodes.map(node => node.val),
                            ...state.nodes.filter(node => node.type === 'conv')
                                .flatMap(node => [node.onlineCap, node.lostCap])
                        ];
                        if (!finiteValues.every(Number.isFinite)) issue = 'non-finite state';
                        else if (Math.abs(nodeGeneration - state.lastTotalGen) > 1e-6) issue = 'generation ledger';
                        else if (Math.abs(actualInertia - state.currentInertiaGvas) > 1e-9) issue = 'inertia ledger';
                        else if (state.nodes.some(node => node.type === 'conv' && (
                            node.onlineCap < -1e-9 || node.lostCap < -1e-9 ||
                            node.onlineCap + node.lostCap > node.cap + 1e-9
                        ))) issue = 'capacity ledger';
                    }
                    return {
                        issue,
                        systemState: state.systemState,
                        collapseReason: state.collapseReason
                    };
                })())`));
                assert.equal(result.issue, null,
                    `${grid} ${scenario} ${disturbance}: ${result.issue}`);
                if (grid === 'morocco' && scenario === 'optimized' && disturbance === 'double_trip') {
                    assert.equal(result.systemState, 'collapsed');
                    assert.equal(result.collapseReason, 'no-synchronous-inertia');
                }
            }
        }
    }
});

test('collapse remains the final event and cannot recover its comfort score', () => {
    const harness = createHarness();
    const result=JSON.parse(harness.run(`
        state.scenario='optimized'; init('morocco'); normalRandom=()=>0;
        const messages=[]; log=message=>messages.push(message);
        setDisturbance('double_trip'); physicsStep(.1);
        JSON.stringify({status:state.systemState,score:state.stability,last:messages.at(-1)});
    `));
    assert.equal(result.status,'collapsed');
    assert.equal(result.score,0);
    assert.match(result.last,/SYSTEM COLLAPSE: no synchronous inertia/);
});
