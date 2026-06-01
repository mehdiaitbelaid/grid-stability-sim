# Grid Stability Simulator

Interactive browser-based simulation platform for studying frequency stability in power grids with high renewable penetration.

Built as part of a BEng dissertation at King's College London (2025/26).

## What it does

- Models the swing equation with governor droop, UFLS protection, and transmission losses
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
- VSM synthetic inertia via supercapacitor derivative term
- Staged UFLS protection matching GB Grid Code relay settings
- Wind turbulence model (multi-frequency sinusoidal)
- Solar diurnal profile
- AGC integral correction
- Transmission loss percentage

## Licence

Academic use. Cite the dissertation if referencing this work.
