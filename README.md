# Grid Stability Simulator

Interactive browser-based simulation platform for studying frequency stability in power grids with high renewable penetration.

Built as part of a BEng dissertation at King's College London (2025/26).

## What it does

- Models the swing equation with committed synchronous inertia, governor droop, UFLS protection, and transmission losses
- Simulates Morocco (ONEE) and UK (NESO) grids with real capacity data from IRENA/ONEE/NESO/DESNZ 2024
- Compares baseline vs. hybrid battery-supercapacitor storage with Virtual Synchronous Machine (VSM) control
- Supports disturbance scenarios: generator trip, N-2, renewable collapse, demand surge, IC loss, cascade
- Exports time-series CSV and captures KPI snapshots for baseline/optimised comparison

## How to run

Open `index.html` in any modern browser. No dependencies, no build step.

## Controls

- **Morocco / UK**: switch grid model
- **Baseline / VSM + Hybrid**: toggle storage scenario
- **Disturbance dropdown**: inject faults
- **Speed**: 1x to 50x time acceleration
- **CSV**: export full time-series
- **KPI**: snapshot current run metrics (run both baseline and optimised to see comparison panel)

## Physics model

Single-bus per-unit swing equation with:
- First-order governor transfer function (servo + reheat lag, fuel-specific ramp limits)
- Droop-based frequency response with configurable deadband
- Contracted battery reserve with a 250 ms response lag and converter ramp limit
- VSM synthetic inertia represented once, as energy-limited supercapacitor power injection
- Dynamic synchronous inertia derived from committed online conventional capacity
- Fixed credible infeed losses shared by baseline and optimised comparison runs
- Staged, latched UFLS with relay and breaker delays
- Overfrequency renewable protection and terminal system-collapse states
- Correlated wind, solar, and load variation
- Solar diurnal profile
- AGC integral correction
- Consistent transmission-loss funding in dispatch
- Rate-limited renewable curtailment
- Approximate DC power flow for line-loading indicators

Battery and supercapacitor state of charge include charge/discharge losses. Hidden
initialisation solves a balanced dispatch at 50 Hz; it does not clamp a failed
dynamic run back to nominal.

## Comparison rules

The baseline and VSM Hybrid modes use the same fixed credible contingency:

- UK: 1,800 MW single loss, 3,000 MW N-2 loss
- Morocco: 900 MW single loss, 1,400 MW N-2 loss

The optimised case deliberately changes renewable, thermal, and storage
capacity, but the disturbance magnitude is held constant. VSM power injection
is not also added to the swing-equation inertia denominator.

## Accounting notes

- Fuel cost covers gas and coal fuel only.
- CO2 covers direct gas and coal emissions only.
- Nuclear fuel, storage degradation, and imported electricity cost/emissions
  are outside the current scope.
- The comfort index is a visual composite of frequency deviation duration, not
  a grid-code stability metric.
- UFLS is latched for the short event studies and has no automatic restoration.

## Model scope

This is a system-frequency teaching model, not a protection-grade network
study. It uses a single coherent system frequency, percentage transmission
losses, an approximate DC flow for operator displays, deterministic aggregate
plant groups, and scripted cascade events. It does not model voltage, reactive
power, electromagnetic transients, detailed converter switching, or geographic
frequency separation.

## Tests

Run the deterministic equation and accounting checks with:

```bash
node tests/physics-core.test.js
```

## Licence

Academic use. Cite the dissertation if referencing this work.
