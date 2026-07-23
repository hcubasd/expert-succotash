# expert-succotash

A redesign of the urban-dollop pipeline grounded in canonical transport modelling.
This document is a working scratchpad for the mathematical model.

---

## Overview

```
zones.gpkg + network.gpkg
supply.csv + demand.csv + batch_size_distribution.csv
vehicles.csv + departure_distribution.csv
        │
        ▼
1. Agent Synthesis
   depletion loop → agents.gpkg (points)
        │
        ▼
2. Spatial Pairing
   Euclidean logistic decay + batch size draws → desire_lines.gpkg
        │
        ▼
3. (Optional) Consolidation
   aggregate desire lines by stratum
        │
        ▼
4. Vehicle Assignment
   MNL over vehicle types → trip counts
        │
        ▼
5. Departure Time Assignment
   TOD PMF draw with feasibility truncation
        │
        ▼
6. Network Assignment
   sequential period Dijkstra + BPR → loaded_links.gpkg
        │
        ▼
7. Emissions
   COPERT V polynomial (exhaust) + flat factors (non-exhaust) → emissions.gpkg
```

---

## Input Files

| file | provided by | purpose |
|---|---|---|
| `zones.gpkg` | user | zone polygons |
| `network.gpkg` | user | road type, grade, geometry |
| `supply.csv` | user | supply totals by stratum and zone |
| `demand.csv` | user | demand totals by stratum and zone |
| `batch_size_distribution.csv` | user | resource flow granularity |
| `vehicles.csv` | user | vehicle types, capacities, costs, COPERT V category |
| `departure_distribution.csv` | user | TOD PMF per resource |
| `emission_factors.csv` | user or bundled | non-exhaust flat g/km per (vehicle type, pollutant) |
| COPERT V coefficients | bundled (parametrizable) | exhaust polynomial coefficients |
| config | user | BPR params, logistic decay α/β, MNL ASCs/betas, road type speeds |

### `supply.csv` and `demand.csv`

One row per stratum per zone:

| column | type | description |
|---|---|---|
| `zone_id` | string | zone this stratum belongs to |
| stratum cols | string | any number of user-defined dimension columns |
| resource cols | integer | total quantity of each resource for this stratum in this zone |

Resources are any named quantities: `am_commuters`, `pm_commuters`, `parcels`, `freight_kg`, etc. UCCs, microhubs, ZEZ households are just strata — no special modules.

### `batch_size_distribution.csv`

| column | description |
|---|---|
| `units` | integer unit count (e.g. 1, 2, 3, 10, 20, 50) |
| one column per resource | probability of a flow batch being this many units |

Each resource column sums to 1. Represents how large individual resource flows are between supply and demand agents — a shipment size, a delivery run, a commute trip.

---

## 1. Agent Synthesis

### Stratum selection weight

For each stratum row $s$, its probability weight for agent synthesis is the weighted average of its resource shares across all resources:

$$w_s = \sum_r \lambda_r \cdot p_{sr}, \qquad p_{sr} = \frac{\text{resource}_{rs}}{\sum_{s'} \text{resource}_{rs'}}$$

where $\lambda_r$ are user-defined resource weights (default $1/R$, sum to 1). Setting $\lambda_r = 0$ excludes a resource from stratum selection without removing it from the depletion process. The $w_s$ sum to 1 by construction.

### Size draw

For each agent, one uniform draw $u \sim U[0,1]$ determines its size across all resources simultaneously. For each resource $r$, apply inverse CDF on its column in `batch_size_distribution.csv`:

$$\text{units}_r = F_r^{-1}(u)$$

Using the same $u$ across all resources induces positive rank correlation — a large agent for one resource tends to be large for others — which is appropriate since agent size reflects a single underlying latent factor (household size, firm size).

### Depletion loop

For each stratum $s$ in zone $z$:

```
while any(remaining_r > 0 for r in resources):
    draw u ~ U[0,1]
    draw (x, y) ~ Uniform(zone_z polygon), redraw if outside polygon
    for each r: assign min(units_r(u), remaining_r) to agent
    for each r: remaining_r -= units_r(u)
```

Agent count per stratum-zone is not predetermined — it emerges from the depletion. Late draws may receive less than their size class for resources already near depletion; this is intentional.

Agents are **points** — no radius, no territory. GIS geometry is Point for agents, Polygon for zones, LineString for network and desire lines.

### Output

`supply_agents.gpkg` and `demand_agents.gpkg` — one point per agent:

| field | description |
|---|---|
| geometry | Point (random location within zone polygon) |
| `zone_id` | zone |
| stratum cols | inherited from stratum row |
| resource cols | actual quantities after depletion clamping |

---

## 2. Spatial Pairing — Desire Lines

### Euclidean distance and logistic decay

Pairing uses Euclidean distance, not network distance. At the pairing stage, actual routes are unknown (they depend on VDF-adjusted Dijkstra computed later). Free-flow Dijkstra would be a less honest approximation than straight-line distance, which makes no claims about routing.

$$f(d) = \frac{1}{1 + \exp(\alpha + \beta \ln d)}$$

where $d$ is Euclidean distance between agent locations. Parameters $\alpha$ and $\beta$ are resource-specific, require calibration from observed flow data.

### Desire line hard cap

Before pairing, compute free-flow Dijkstra travel time $t_{ij}$ for each supply-demand node pair (snapping agent locations to nearest network nodes). Drop any pair where:

- **Cargo** (`returns_empty: true`): $t_{ij} + t_{ji} > \text{max\_shift\_duration}$ — round trip must fit in driver shift
- **Person trips** (`returns_empty: false`): $t_{ij} > \text{max\_trip\_duration}$ — one-way only; return is a separate resource

Report dropped pairs as unserviceable.

### Probabilistic matching with batch sizes

For each resource $r$, determine the limiter (smaller total across all agents). Exhaust the limiter:

```
while any(remaining_r > 0):
    draw supply agent i  with P(i) ∝ remaining Q_i^r
    draw demand agent j  with P(j|i) ∝ remaining Q_j^r · f(d_ij)
    draw batch size b from batch_size_distribution for resource r
    transfer = min(b, remaining Q_i^r, remaining Q_j^r)
    subtract transfer from both; accumulate on desire line (i, j)
```

Desire lines between the same $(i, j)$ pair accumulate across draws. Unfulfilled supply or demand is reported as simulation output (unmatched workers, undelivered parcels, etc.).

### Return trips

- **Cargo** (`returns_empty: true`): for each desire line $(i, j)$, generate a reverse desire line $(j, i)$ with the same vehicle type and load = 0. Adds empty vehicle-km to network loading and emissions.
- **Person trips** (`returns_empty: false`): return is modeled as a separate resource (e.g. `pm_commuters` is the return of `am_commuters`). No automatic empty return.

### Output

`desire_lines.gpkg` — one LineString per $(i, j, \text{resource})$ with accumulated flow.

---

## 3. Optional: Consolidation

Aggregate desire lines by stratum before vehicle assignment:

```yaml
consolidations:
  - resource: parcels
    side: demand
    group_by: zone_id
  - resource: freight_kg
    side: supply
    group_by: [carrier_id, zone_id]
```

Reduces many small flows into fewer large ones. Consolidated location: TBD (centroid of grouped agents or largest agent's node).

Chaining (defining a UCC stratum that receives one resource and supplies another) is complementary and orthogonal to this step.

---

## 4. Vehicle Assignment

For each desire line $(i, j, r)$ with accumulated flow $Q$:

### MNL over vehicle types

Eligible vehicle types per resource are user-defined. Systematic utility:

$$V_v = \alpha_v^r + \beta_1 \cdot \frac{Q}{C_v} + \beta_2 \cdot c_{ij} \cdot \text{cost}_v$$

Choice probability:

$$P(v \mid i, j, r) = \frac{\exp(V_v)}{\sum_k \exp(V_k)}$$

Simple case: user provides vehicle PMF directly per resource (ASC-only MNL, $\beta = 0$).

### Trip count

$$n_{\text{trips}} = \left\lceil \frac{Q}{C_v} \right\rceil, \quad v \sim P(v \mid i, j, r)$$

Load: $\lfloor Q / C_v \rfloor$ trips at 100%, one remainder trip at $(Q \bmod C_v) / C_v$.

### Commutes

Vehicle types are transport modes (car, transit, bike, walk). Car capacity = 1 person (or average occupancy). Only car loads the road network.

---

## 5. Departure Time Assignment

Each resource has a TOD PMF (non-negative, sums to 1 over simulation periods) in `departure_distribution.csv`. Converted internally to CDF.

### Feasibility truncation

Latest feasible departure for trip $(i, j)$:

$$t_{\text{latest}} = t_{\text{sim\_end}} - t_{ij} \quad \text{(one-way)} \qquad \text{or} \qquad t_{\text{sim\_end}} - (t_{ij} + t_{ji}) \quad \text{(round trip)}$$

Truncate TOD PMF at $t_{\text{latest}}$, renormalize, draw departure time. Trips with zero PMF mass before cutoff are reported as unserviceable. Longer trips automatically receive earlier expected departures — behaviorally correct.

---

## 6. Network Assignment

### Routing model

Vehicles route on the network state at departure time — the Google Maps model. No time-dependent Dijkstra. Routes are fixed at departure and do not update mid-trip.

### Loading model

Routes are traced link by link with accumulated travel time. Each link is attributed to the period the vehicle actually traverses it (traversal-time loading). Vehicles still in transit from earlier periods contribute to the current period's link flows.

### Period 0

Free-flow speeds from config (or vehicle × road type file). Dijkstra runs once per unique origin node and is cached.

### Period $h > 0$

1. Route departing vehicles using current link speeds $v_\ell^h$
2. Trace routes, attribute links to traversal period
3. Count flows $q_\ell^h$ per link
4. Update speeds via BPR:

$$v_\ell^{h+1} = \frac{v_\ell^0}{1 + \alpha \left(\dfrac{q_\ell^h}{Q_\ell}\right)^\beta}$$

Default: $\alpha = 0.15$, $\beta = 4$. Capacity $Q_\ell$ user-supplied per road type. Re-run Dijkstra with updated weights at the start of each period.

### Output

`loaded_links.gpkg` — one row per (link, period, vehicle type):

| field | description |
|---|---|
| geometry | LineString |
| `road_type`, `grade_pct` | from network |
| `period` | simulation period index |
| `vehicle_type` | vehicle type |
| `n_trips` | vehicles on this link in this period |
| `velocity_kmh` | BPR-adjusted speed for this period |

---

## 7. Emissions

### Exhaust — COPERT V polynomial

$$\text{EF} \ [\text{g/km}] = \frac{\alpha V^2 + \beta V + \gamma + \delta/V}{\varepsilon V^2 + \zeta V + \eta} \cdot (1 - \text{RF})$$

Coefficients ($\alpha, \beta, \gamma, \delta, \varepsilon, \zeta, \eta, \text{RF}$) are indexed by (vehicle type, pollutant, gradient bin, load bin). Bundled defaults cover standard COPERT V vehicle categories; user can override per cell. Speed $V$ is the VDF-adjusted `velocity_kmh` from the loaded network — evaluated continuously, no bucketing.

Gradient and load are interpolated between their discrete bins. Links with $|\text{grade}| > 6\%$ were excluded at the network level (COPERT V validity range).

This is the same methodology as Dias & Jenelius (2026), with the improvement that $V$ is link- and period-specific from BPR rather than a flat scenario speed.

### Non-exhaust — flat factors

`emission_factors.csv` — (vehicle type, pollutant) → flat g/km. Covers tyre wear, brake wear, road surface abrasion. PM only. Bundled EEA EMEP defaults, user-overridable.

### Emission per (link, period, vehicle type, pollutant)

$$\text{emission\_g} = n_{\text{trips}} \cdot \frac{d_\ell}{1000} \cdot \text{EF}(V_\ell, s_\ell, \text{load\_pct})$$

### Output

`emissions.gpkg` — spatially explicit emission inventory per link per period. Serves directly as a hotspot map and as source-term input for atmospheric dispersion modelling (AERMOD, CALPUFF) if concentration plumes are needed downstream.

---

## Open / TBD

- **Vehicle × road type velocity**: config (one speed per road type) or separate file (speed per vehicle type × road type)
- **Consolidation location**: centroid of grouped agents vs. largest agent's node
- **KPIs**: not yet specified
