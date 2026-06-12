'use strict';

const assert = require('node:assert/strict');
const physics = require('../physics-core.js');

function close(actual, expected, tolerance, message) {
    assert.ok(Math.abs(actual - expected) <= tolerance,
        `${message}: expected ${expected}, got ${actual}`);
}

const midnightBefore = physics.dailyLoadProfile(23.999, 45000, 32000);
const midnightAfter = physics.dailyLoadProfile(0.001, 45000, 32000);
close(midnightBefore, midnightAfter, 0.0002, 'daily profile is continuous at midnight');

const requiredConv = physics.dispatchRequirement(40000, 12000, 0.02);
close((requiredConv + 12000) * 0.98, 40000, 1e-9, 'dispatch funds all losses');

const baselineFleet = [
    { type: 'conv', fuel: 'nuclear', cap: 7700 },
    { type: 'conv', fuel: 'gas', cap: 32000 }
];
const optimizedFleet = [
    { type: 'conv', fuel: 'nuclear', cap: 7700 },
    { type: 'conv', fuel: 'gas', cap: 22400 }
];
const baseH = physics.computeSyncInertia(baselineFleet, 45000, 0, 4).seconds;
const optimizedH = physics.computeSyncInertia(optimizedFleet, 45000, 0, 4).seconds;
assert.ok(optimizedH < baseH, 'optimized high-renewable fleet has lower synchronous inertia');
const committedH = physics.computeSyncInertia([
    { type: 'conv', fuel: 'gas', cap: 10000, onlineCap: 5000 }
], 10000, 0, 4).seconds;
close(committedH, 2, 1e-12, 'inertia uses committed online capacity');
close(
    physics.computeSyncInertia(baselineFleet, 45000, 1800, 4).seconds,
    baseH - 4 * 1800 / 45000,
    1e-12,
    'credible loss removes associated synchronous inertia'
);

const expectedRocof = (-1800 / (2 * baseH * 45000)) * 50;
close(
    physics.swingDfdt(-1800, 45000, 0, 50, baseH),
    expectedRocof,
    1e-12,
    'swing equation identity'
);

let response = 0;
for (let i = 0; i < 5; i++) response = physics.firstOrderRamp(response, 1000, 0.1, 0.25, 10000);
assert.ok(response < 900, 'battery response is below 90% at 0.5 seconds');
for (let i = 0; i < 3; i++) response = physics.firstOrderRamp(response, 1000, 0.1, 0.25, 10000);
assert.ok(response > 900, 'battery response passes 90% after the modeled lag');

const discharge = physics.storageEnergyStep(50, 100, 20, 3600, 0.95, 0.95);
close(
    discharge.gridEnergyMWh,
    -discharge.storedDeltaMWh - discharge.lossesMWh,
    1e-9,
    'discharge energy ledger closes'
);
const charge = physics.storageEnergyStep(50, 100, -20, 3600, 0.95, 0.95);
close(
    charge.gridEnergyMWh,
    -charge.storedDeltaMWh - charge.lossesMWh,
    1e-9,
    'charge energy ledger closes'
);

let ouCoarse = 1;
for (let i = 0; i < 100; i++) ouCoarse = physics.ouStep(ouCoarse, 1, 10, 0.1, 0);
let ouFine = 1;
for (let i = 0; i < 200; i++) ouFine = physics.ouStep(ouFine, 1, 10, 0.05, 0);
close(ouCoarse, ouFine, 1e-12, 'correlated-noise decay is timestep invariant');

const uflsStage = { freqHz: 48.8, delay: 0.35 };
let ufls = { latched: false, timerSeconds: 0 };
for (let i = 0; i < 3; i++) {
    ufls = physics.stepUflsStage(uflsStage, ufls.latched, ufls.timerSeconds, 48.799, 0.1);
}
assert.equal(ufls.latched, false, 'UFLS does not trip before its delay');
ufls = physics.stepUflsStage(uflsStage, ufls.latched, ufls.timerSeconds, 48.799, 0.05);
assert.equal(ufls.latched, true, 'UFLS trips exactly at its qualification delay');
ufls = physics.stepUflsStage(uflsStage, ufls.latched, ufls.timerSeconds, 50, 1);
assert.equal(ufls.latched, true, 'UFLS remains latched after frequency recovery');

const dcNodes = [
    { id: 'A', p: 100 },
    { id: 'B', p: -60 },
    { id: 'C', p: -40 }
];
const dcLines = [
    { from: 'A', to: 'B', cap: 100 },
    { from: 'B', to: 'C', cap: 100 },
    { from: 'A', to: 'C', cap: 100 }
];
const flows = physics.solveDcPowerFlow(dcNodes, dcLines, 'A');
close(flows['A-B'] - flows['B-C'], 60, 1e-9, 'DC flow conserves power at node B');
close(flows['A-C'] + flows['B-C'], 40, 1e-9, 'DC flow conserves power at node C');

const benchmark = {
    credibleLossMW: 1800,
    doubleLossMW: 3000,
    fuelCostGas: 50,
    co2Gas: 400
};
assert.equal(physics.contingencySize(benchmark, 'gen_trip'), 1800);
assert.equal(physics.contingencySize(benchmark, 'double_trip'), 3000);
const economics = physics.fuelEconomics(
    [{ type: 'conv', fuel: 'gas', val: 1000 }],
    benchmark
);
assert.equal(economics.fuelCostPerHour, 50000);
assert.equal(economics.co2KgPerHour, 400000);

assert.equal(physics.classifyFrequency(47.49), 'underfrequency-collapse');
assert.equal(physics.classifyFrequency(52.01), 'overfrequency-collapse');
assert.equal(physics.classifyFrequency(49.5), 'operational');
close(physics.nadirImprovementPercent(49.2, 49.6), 50, 1e-9,
    'nadir comparison uses deviation from nominal');

const gov = new physics.GovernorModel('coal', 1000);
gov.init(1);
gov.step(0, 1);
const throughZero = gov.step(-100, 1);
assert.ok(throughZero >= 0, 'governor ramp limit remains active through zero');

console.log('physics-core regression tests passed');
