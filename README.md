# Grid Stability Simulator

Interactive browser-based simulation platform for studying frequency stability in power grids with high renewable penetration.

Built as part of a BEng dissertation at King's College London (2025/26).

## What it does

- Models the swing equation with committed synchronous inertia, governor droop, UFLS protection, and transmission losses
- Simulates Morocco (ONEE) and UK (NESO) grids with real capacity data from IRENA/ONEE/NESO/DESNZ 2024
- Compares baseline vs. hybrid battery-supercapacitor storage with Virtual Synchronous Machine (VSM) control
- Supports disturbance scenarios: generator trip, N-2, renewable collapse, demand surge, IC loss, cascade

## How to run

Open `index.html` in any modern browser. No dependencies, no build step.

## Controls

- **Morocco / UK**: switch grid model
- **Baseline / VSM + Hybrid**: toggle storage scenario
- **Disturbance dropdown**: inject a fault into the running model. Selecting a new study after an existing fault restores the fleet and starts at noon.
- **Speed**: target acceleration from 1x to 1800x. Every speed uses the same 0.1 second physics step. Slower devices may fall behind the target; pending simulation time is retained.

## Physics model

Single-bus per-unit swing equation with:
- First-order governor transfer function (servo + reheat lag, fuel-specific ramp limits)
- Droop-based frequency response with configurable deadband
- Contracted battery reserve with a 250 ms response lag and converter ramp limit
- VSM synthetic inertia represented once, as energy-limited supercapacitor power injection
- Synchronous inertia derived only from committed online conventional capacity
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
initialisation solves a balanced dispatch at 50 Hz. Conventional commitment
includes the assumed inertia target and its associated minimum operating output.
If the installed fleet cannot reach the target, the simulator uses its actual
inertia and logs the shortfall. For example, the optimized UK conventional fleet
can provide at most 128.1 GVA·s against the assumed 140 GVA·s target.

Normal operation updates aggregate commitment at dispatch intervals. Commitment
is frozen during a disturbance study: lost synchronous capacity is not instantly
replaced to restore an inertia target. This remains an aggregate model, without
individual unit startup times or a unit commitment optimizer.

If a contingency removes all synchronous inertia, the model stops with an
explicit `no-synchronous-inertia` collapse state. The frequency readout retains
the last finite observation; it is not a prediction of continued stable operation.
The VSM power injection model does not simulate a fully inverter-based island.

## Comparison rules

The baseline and VSM Hybrid modes use the same fixed credible contingency:

- UK: 1,800 MW single loss, 3,000 MW N-2 loss
- Morocco: 900 MW single loss, 1,400 MW N-2 loss

The optimised case deliberately changes renewable, thermal, and storage
capacity, but the disturbance magnitude is held constant. VSM power injection
is not also added to the swing-equation inertia denominator.

Each loss removes proportional output and online capacity from the operating
conventional plant groups. Dispatch availability, inertia, fuel, and network
injections all use the reduced fleet; the loss is not subtracted a second time
from the system total. Nameplate capacity remains unchanged.

Normal dispatch retains at least the advertised N-2 conventional output for
these experiments, curtailing renewables when needed. If a fault is armed in an
operating state with less conventional output than requested, its actual loss is
limited to that output and explicitly logged. Weather realizations still vary
between interactive resets, so use shared deterministic inputs for quantitative
baseline comparisons.

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
node --test tests/*.test.js
```

The tests include equation and energy identities, commitment limits, node and
system power accounting after faults, every country/mode/disturbance combination,
zero-inertia termination, control resets, equal-speed event outcomes, and frame
backlog conservation. The browser harness executes the actual application code
with rendering stubbed and deterministic inputs.

## Licence

Academic use. Cite the dissertation if referencing this work.
