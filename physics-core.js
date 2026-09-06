(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.GridPhysics = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FUEL_INERTIA_SECONDS = {
        nuclear: 5.0,
        gas: 4.0,
        coal: 4.0,
        hydro: 3.0
    };

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function dailyLoadProfile(hour, peakDemand, averageDemand) {
        const averageRatio = clamp(averageDemand / peakDemand, 0.55, 0.85);
        const phase = (hour - 18) * Math.PI / 12;
        return averageRatio + (1 - averageRatio) * Math.cos(phase);
    }

    function ouStep(value, sigma, tauSeconds, dt, normalSample) {
        const decay = Math.exp(-dt / Math.max(dt, tauSeconds));
        return value * decay + sigma * Math.sqrt(1 - decay * decay) * normalSample;
    }

    function firstOrderRamp(current, target, dt, tauSeconds, maxRampPerSecond) {
        const lagged = target + (current - target) * Math.exp(-dt / Math.max(dt, tauSeconds));
        const maxDelta = Math.max(0, maxRampPerSecond) * dt;
        return current + clamp(lagged - current, -maxDelta, maxDelta);
    }

    function dispatchRequirement(totalLoad, nonConventionalNetPower, lossFraction) {
        const retained = Math.max(0.01, 1 - lossFraction);
        return Math.max(0, totalLoad / retained - nonConventionalNetPower);
    }

    function computeSyncInertia(nodes, baseMVA, contingencyInertiaMW, contingencyH, minimumGvaSeconds) {
        let inertiaMVASeconds = 0;
        nodes.forEach(node => {
            if (node.type !== 'conv' || node.tripped) return;
            const h = FUEL_INERTIA_SECONDS[node.fuel] || 4.0;
            const onlineCapacity = node.onlineCap !== undefined ? node.onlineCap : node.cap;
            inertiaMVASeconds += h * Math.max(0, onlineCapacity || 0);
        });
        inertiaMVASeconds -= Math.max(0, contingencyInertiaMW || 0) * (contingencyH || 4.0);
        const gvaSeconds = Math.max(0, inertiaMVASeconds) / 1000;
        return {
            seconds: gvaSeconds * 1000 / baseMVA,
            gvaSeconds,
            shortfallGvaSeconds: Math.max(0, (minimumGvaSeconds || 0) - gvaSeconds)
        };
    }

    function availableCapacity(node) {
        return node.tripped ? 0 : Math.max(0, node.cap - (node.lostCap || 0));
    }

    function conventionalLimits(node, optimized) {
        const capacity = Math.min(availableCapacity(node), node.onlineCap ?? node.cap);
        const minFraction = node.fuel === 'nuclear' ? 0.60 :
            (optimized ? 0.15 : (node.fuel === 'coal' ? 0.35 : 0.30));
        return {
            min: capacity * minFraction,
            max: capacity * (node.fuel === 'nuclear' ? 0.60 : 0.95)
        };
    }

    function commitConventional(nodes, requiredMW, minimumGvaSeconds) {
        const plants = nodes.filter(n => n.type === 'conv');
        const flexible = plants.filter(n => n.fuel !== 'nuclear');
        const nuclearMW = plants.filter(n => n.fuel === 'nuclear')
            .reduce((sum, n) => sum + availableCapacity(n) * 0.60, 0);
        const flexibleCap = flexible.reduce((sum, n) => sum + availableCapacity(n), 0);
        plants.forEach(n => {
            const capacity = availableCapacity(n);
            const share = flexibleCap > 0 ? capacity / flexibleCap : 0;
            const energyCommitment = Math.max(0, requiredMW - nuclearMW) * share / 0.75;
            n.onlineCap = n.fuel === 'nuclear' ? capacity :
                Math.min(capacity, Math.max(energyCommitment, Math.max(0, n.val || 0) / 0.95));
        });
        const h = n => FUEL_INERTIA_SECONDS[n.fuel] || 4;
        const committed = plants.reduce((sum, n) => sum + h(n) * n.onlineCap, 0);
        const headroom = plants.reduce((sum, n) => sum + h(n) * (availableCapacity(n) - n.onlineCap), 0);
        const fraction = headroom > 0 ? clamp(((minimumGvaSeconds || 0) * 1000 - committed) / headroom, 0, 1) : 0;
        plants.forEach(n => { n.onlineCap += fraction * (availableCapacity(n) - n.onlineCap); });
    }

    function dispatchConventional(nodes, requiredMW, optimized) {
        const plants = nodes.filter(n => n.type === 'conv');
        const limits = plants.map(n => conventionalLimits(n, optimized));
        const minimum = limits.reduce((sum, p) => sum + p.min, 0);
        const headroom = limits.reduce((sum, p) => sum + p.max - p.min, 0);
        const fraction = headroom > 0 ? clamp((requiredMW - minimum) / headroom, 0, 1) : 0;
        return Object.fromEntries(plants.map((n, i) => [n.id,
            limits[i].min + fraction * (limits[i].max - limits[i].min)]));
    }

    function tripConventional(nodes, requestedMW) {
        const plants = nodes.filter(n => n.type === 'conv' && !n.tripped && n.val > 0);
        const total = plants.reduce((sum, n) => sum + n.val, 0);
        const fraction = total > 0 ? clamp(requestedMW / total, 0, 1) : 0;
        let lostCapacityMW = 0;
        plants.forEach(n => {
            const lost = (n.onlineCap ?? n.cap) * fraction;
            lostCapacityMW += lost;
            n.lostCap = (n.lostCap || 0) + lost;
            n.onlineCap = (n.onlineCap ?? n.cap) - lost;
            n.val *= 1 - fraction;
            n.p = n.val;
            n.tripped = n.onlineCap <= 1e-9;
        });
        return { powerMW: total * fraction, capacityMW: lostCapacityMW, fraction };
    }

    function swingDfdt(imbalanceMW, baseMVA, dampingD, frequencyHz, inertiaSeconds) {
        const puImbalance = imbalanceMW / baseMVA;
        const puDeviation = (frequencyHz - 50) / 50;
        return ((puImbalance - dampingD * puDeviation) / (2 * inertiaSeconds)) * 50;
    }

    function storageEnergyStep(
        socPercent,
        capacityMWh,
        requestedPowerMW,
        dt,
        chargeEfficiency,
        dischargeEfficiency
    ) {
        const chargeEff = clamp(chargeEfficiency, 0.01, 1);
        const dischargeEff = clamp(dischargeEfficiency, 0.01, 1);
        const energyBefore = clamp(socPercent, 0, 100) / 100 * capacityMWh;
        const maxDischarge = energyBefore * dischargeEff * 3600 / Math.max(dt, 1e-9);
        const maxCharge = (capacityMWh - energyBefore) / chargeEff * 3600 / Math.max(dt, 1e-9);
        const powerMW = clamp(requestedPowerMW, -maxCharge, maxDischarge);

        let storedDeltaMWh;
        let lossesMWh;
        if (powerMW >= 0) {
            storedDeltaMWh = -(powerMW / dischargeEff) * dt / 3600;
            lossesMWh = powerMW * (1 / dischargeEff - 1) * dt / 3600;
        } else {
            storedDeltaMWh = (-powerMW * chargeEff) * dt / 3600;
            lossesMWh = (-powerMW * (1 - chargeEff)) * dt / 3600;
        }

        const energyAfter = clamp(energyBefore + storedDeltaMWh, 0, capacityMWh);
        return {
            powerMW,
            socPercent: capacityMWh > 0 ? energyAfter / capacityMWh * 100 : 0,
            storedDeltaMWh: energyAfter - energyBefore,
            gridEnergyMWh: powerMW * dt / 3600,
            lossesMWh
        };
    }

    function solveLinearSystem(matrix, vector) {
        const n = vector.length;
        const a = matrix.map((row, i) => row.slice().concat(vector[i]));
        for (let col = 0; col < n; col++) {
            let pivot = col;
            for (let row = col + 1; row < n; row++) {
                if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
            }
            if (Math.abs(a[pivot][col]) < 1e-10) return new Array(n).fill(0);
            if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];

            const divisor = a[col][col];
            for (let j = col; j <= n; j++) a[col][j] /= divisor;
            for (let row = 0; row < n; row++) {
                if (row === col) continue;
                const factor = a[row][col];
                for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
            }
        }
        return a.map(row => row[n]);
    }

    function solveDcPowerFlow(nodes, lines, slackId) {
        if (!nodes.length) return {};
        const index = new Map(nodes.map((node, i) => [node.id, i]));
        const n = nodes.length;
        const bMatrix = Array.from({ length: n }, () => new Array(n).fill(0));

        lines.forEach(line => {
            const i = index.get(line.from);
            const j = index.get(line.to);
            if (i === undefined || j === undefined) return;
            const susceptance = Math.max(0.05, (line.cap || 1000) / 1000);
            bMatrix[i][i] += susceptance;
            bMatrix[j][j] += susceptance;
            bMatrix[i][j] -= susceptance;
            bMatrix[j][i] -= susceptance;
        });

        const slack = index.has(slackId) ? index.get(slackId) : 0;
        const keep = [];
        for (let i = 0; i < n; i++) if (i !== slack) keep.push(i);
        const reduced = keep.map(i => keep.map(j => bMatrix[i][j]));
        const injections = keep.map(i => Number(nodes[i].p) || 0);
        const solved = solveLinearSystem(reduced, injections);
        const theta = new Array(n).fill(0);
        keep.forEach((nodeIndex, i) => { theta[nodeIndex] = solved[i]; });

        const flows = {};
        lines.forEach(line => {
            const i = index.get(line.from);
            const j = index.get(line.to);
            if (i === undefined || j === undefined) return;
            const susceptance = Math.max(0.05, (line.cap || 1000) / 1000);
            flows[line.from + '-' + line.to] = susceptance * (theta[i] - theta[j]);
        });
        return flows;
    }

    function fuelEconomics(nodes, benchmark) {
        let fuelCostPerHour = 0;
        let co2KgPerHour = 0;
        nodes.forEach(node => {
            if (node.type !== 'conv' || node.tripped) return;
            const output = Math.max(0, node.val || 0);
            if (node.fuel === 'gas') {
                fuelCostPerHour += output * (benchmark.fuelCostGas || 50);
                co2KgPerHour += output * (benchmark.co2Gas || 400);
            } else if (node.fuel === 'coal') {
                fuelCostPerHour += output * (benchmark.fuelCostCoal || 35);
                co2KgPerHour += output * (benchmark.co2Coal || 900);
            }
        });
        return { fuelCostPerHour, co2KgPerHour };
    }

    function contingencySize(benchmark, kind) {
        const single = benchmark.credibleLossMW || 1000;
        return kind === 'double_trip' ? (benchmark.doubleLossMW || single * 1.6) : single;
    }

    function classifyFrequency(frequencyHz) {
        if (!Number.isFinite(frequencyHz)) return 'numerical-failure';
        if (frequencyHz <= 47.5) return 'underfrequency-collapse';
        if (frequencyHz >= 52.0) return 'overfrequency-collapse';
        return 'operational';
    }

    function stepUflsStage(stage, latched, timerSeconds, frequencyHz, dt) {
        if (latched) return { latched: true, timerSeconds };
        const nextTimer = frequencyHz <= stage.freqHz ? timerSeconds + dt : 0;
        return {
            latched: nextTimer + 1e-12 >= stage.delay,
            timerSeconds: nextTimer
        };
    }

    function nadirImprovementPercent(baselineNadir, optimizedNadir) {
        const baselineDeviation = Math.max(0, 50 - baselineNadir);
        const optimizedDeviation = Math.max(0, 50 - optimizedNadir);
        if (baselineDeviation < 1e-9) return null;
        return (baselineDeviation - optimizedDeviation) / baselineDeviation * 100;
    }

    class GovernorModel {
        constructor(fuel, capacity) {
            this.fuel = fuel;
            this.cap = capacity;
            switch (fuel) {
                case 'nuclear':
                    this.Tg = 0.5;
                    this.Tr = 30.0;
                    this.rampMax = capacity * 0.0005;
                    break;
                case 'coal':
                    this.Tg = 0.3;
                    this.Tr = 8.0;
                    this.rampMax = capacity * 0.0005;
                    break;
                default:
                    this.Tg = 0.2;
                    this.Tr = 5.0;
                    this.rampMax = capacity * 0.0033;
                    break;
            }
            this.servoOut = 0;
            this.turbineOut = 0;
            this._lastOut = undefined;
        }

        step(target, dt) {
            this.servoOut += (dt / (this.Tg + dt)) * (target - this.servoOut);
            this.turbineOut += (dt / (this.Tr + dt)) * (this.servoOut - this.turbineOut);
            const previous = this._lastOut !== undefined ? this._lastOut : this.turbineOut;
            const maxDelta = this.rampMax * dt;
            const output = clamp(this.turbineOut, previous - maxDelta, previous + maxDelta);
            this.turbineOut = output;
            this._lastOut = output;
            return output;
        }

        init(output) {
            this.servoOut = output;
            this.turbineOut = output;
            this._lastOut = output;
        }
    }

    return {
        FUEL_INERTIA_SECONDS,
        GovernorModel,
        clamp,
        dailyLoadProfile,
        ouStep,
        firstOrderRamp,
        dispatchRequirement,
        computeSyncInertia,
        conventionalLimits,
        commitConventional,
        dispatchConventional,
        tripConventional,
        swingDfdt,
        storageEnergyStep,
        solveDcPowerFlow,
        fuelEconomics,
        contingencySize,
        classifyFrequency,
        stepUflsStage,
        nadirImprovementPercent
    };
}));
