# expert-succotash

A redesign of the urban-dollop pipeline grounded in canonical transport modelling.
This document is a working scratchpad for the mathematical model.

---

## Overview

```
zones.gpkg + network.gpkg + supply.csv + demand.csv
        │
        ▼
1. Agent Synthesis
   atom placement on links → combination → agents.gpkg
        │
        ▼
2. Spatial Pairing
   probabilistic matching via logistic decay → desire_lines.gpkg
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
7. Emissions + KPIs
```

---

## Inputs

### `zones.gpkg`
Zone polygons. Required field: `zone_id`. Geometry: Polygon.

### `network.gpkg`
Directed road network. Required fields: `road_type`, `grade_pct`. Geometry: LineString.
Speed per road type supplied in config. Distance derived from geometry length.

### `supply.csv` and `demand.csv`

One row per stratum. Columns:

| column | type | description |
|---|---|---|
| `zone_id` | string | zone this stratum belongs to |
| stratum cols | string | any number of user-defined dimension columns |
| resource cols | integer | quantity of each resource per stratum |

Resources are any named quantities the user defines: `am_commuters`, `pm_commuters`, `parcels`, `freight_kg`, `green_parcels`, `consolidated_parcels`, etc. Strata columns can differ between supply.csv and demand.csv. Resource units should be chosen for the precision needed — if sub-tonne precision is required, use `freight_kg` not `freight_tonnes`.

UCCs, microhubs, ZEZ households, catchment zones are all just strata in these two files. No special modules or hardcoded agent types.

---

## 1. Agent Synthesis

Agents are not specified directly. They emerge from atom placement and combination.

### Atom count per stratum

For each stratum row $s$, the number of atoms to place is:

$$N_s = \max_r(\text{resource}_{rs})$$

the maximum resource count across all resource columns. This preserves the spatial resolution of the highest-volume resource. Other resources are attributed fractionally per atom.

### Stratum selection weight

Each atom draws its stratum from a CDF over strata. The weight for stratum $s$ is the weighted average of its resource shares across all resources:

$$w_s = \sum_r \lambda_r \cdot p_{sr}, \qquad p_{sr} = \frac{\text{resource}_{rs}}{\sum_{s'} \text{resource}_{rs'}}$$

where $\lambda_r$ are user-defined resource weights (default $1/R$ each, must sum to 1). Setting $\lambda_r = 0$ excludes a resource from stratum selection without removing it from attribution. Since each $p_{sr}$ sums to 1 over strata, and $\sum_r \lambda_r = 1$, the weights $w_s$ sum to 1 by construction — no normalisation needed.

### Atom placement

For each zone $z$:

1. Collect all road network links intersecting zone $z$
2. Weight links by length: $P(\ell) \propto \text{length}_\ell$
3. For each atom: draw a link from this distribution, then draw a position uniformly along that link
4. Assign stratum via inverse CDF on $w_s$

### Agent formation

Atoms of the same stratum landing on the same link combine into one agent. The agent's location is the centroid of its constituent atom positions. Resource quantities for agent $a$ formed from $n_a$ atoms of stratum $s$:

$$q_a^r = n_a \cdot \frac{\text{resource}_{rs}}{N_s}$$

At most one agent per (link, stratum, zone) combination — this is a natural spatial resolution limit tied to the road network density.

### Supply and demand attribution

An agent can belong to different strata in supply.csv and demand.csv. Using the same uniform draw for both implies correlated supply and demand strata, which is appropriate when the same characteristics drive both. The agent's supply and demand quantities for each resource are read from the matching stratum rows.

---

## 2. Spatial Pairing — Desire Lines

### Grade-weighted time-based Dijkstra

Edge cost for link $\ell$ with distance $d_\ell$ (m), road type speed $v_\ell$ (m/s), and grade $s_\ell$ (%):

$$C_\ell = w_1 \cdot \frac{d_\ell}{v_\ell} + w_2 \cdot |s_\ell| \cdot d_\ell$$

Links with $|s_\ell| > 6\%$ are excluded (COPERT V validity range). Single-source Dijkstra runs once per unique origin node and is cached. This cache is also used for network assignment period 0.

### Logistic decay

$$f(c) = \frac{1}{1 + \exp(\alpha + \beta \ln c)}$$

Parameters $\alpha$ and $\beta$ are resource-specific and require calibration from observed flow data.

### Desire line hard cap

Before pairing, drop any agent pair $(i, j)$ where the free-flow Dijkstra travel time exceeds `max_trip_duration`. Report dropped pairs as unserviceable demand.

### Probabilistic matching

For each resource $r$, determine the limiter — whichever side has smaller total:

- **Supply is limiter** ($\sum_i P_i^r < \sum_j A_j^r$): iterate over supply atoms; for each atom at agent $i$ draw destination $j$:

$$P(j \mid i) = \frac{A_j^r \cdot f(c_{ij})}{\sum_k A_k^r \cdot f(c_{ik})}$$

- **Demand is limiter** ($\sum_j A_j^r < \sum_i P_i^r$): iterate over demand atoms; for each atom at agent $j$ draw origin $i$:

$$P(i \mid j) = \frac{P_i^r \cdot f(c_{ij})}{\sum_k P_k^r \cdot f(c_{kj})}$$

One draw per atom produces one desire line. Desire lines between the same $(i, j)$ pair accumulate. Iterating over the limiter side gives a computational bonus — fewer atoms to exhaust. Unfulfilled supply or demand is reported as a simulation output (unmatched workers, undelivered parcels, etc.).

### Output

`desire_lines.gpkg` — one LineString per $(i, j, \text{resource})$ pair with nonzero accumulated flow.

---

## 3. Optional: Consolidation

Before vehicle assignment, aggregate desire lines by stratum to model consolidation points (microhubs, zone pickups, carrier depots).

Config:

```yaml
consolidations:
  - resource: parcels
    side: demand
    group_by: zone_id
  - resource: freight_kg
    side: supply
    group_by: [carrier_id, zone_id]
```

Each entry sums flows with matching `group_by` values into one consolidated desire line. Reduces many small flows into fewer large ones before vehicle assignment.

Consolidated location rule: TBD (centroid of grouped agents, or largest agent's node).

Note: consolidation via chaining (defining a UCC stratum that demands one resource and supplies another) is a complementary mechanism and is orthogonal to this step.

---

## 4. Vehicle Assignment

For each desire line $(i, j, r)$ with flow quantity $Q$:

### MNL over vehicle types

Eligible vehicle types for resource $r$ are user-defined. Systematic utility of vehicle $v$:

$$V_v = \alpha_v^r + \beta_1 \cdot \frac{Q}{C_v} + \beta_2 \cdot c_{ij} \cdot \text{cost}_v$$

where $C_v$ is vehicle capacity in resource units (kg, parcels, persons) and $\text{cost}_v$ is cost per unit distance. Choice probability:

$$P(v \mid i, j, r) = \frac{\exp(V_v)}{\sum_k \exp(V_k)}$$

Simple case: user provides a vehicle PMF directly per resource. This is equivalent to ASC-only MNL ($\beta = 0$) — the distribution does not vary by flow size or distance.

### Trip count

$$n_{\text{trips}} = \left\lceil \frac{Q}{C_v} \right\rceil, \quad v \sim P(v \mid i, j, r)$$

### Commutes

Commute resources (`am_commuters`, `pm_commuters`, etc.) use mode choice MNL where vehicle types are transport modes (car, transit, bike, walk). Car capacity = 1 person (or average occupancy). Only car mode loads the road network; other modes do not contribute to network flows or emissions in the current model.

---

## 5. Departure Time Assignment

Each resource has a user-defined TOD PMF — non-negative values summing to 1 over simulation periods. Converted internally to a CDF.

### Feasibility truncation

For each trip on desire line $(i, j)$ with free-flow travel time $t_{ij}$:

$$t_{\text{latest}} = t_{\text{sim\_end}} - t_{ij}$$

Truncate the TOD PMF at $t_{\text{latest}}$, renormalize, draw departure time from the truncated CDF. Trips with zero PMF mass before the cutoff are reported as unserviceable and dropped.

This means longer trips automatically receive earlier expected departure times — behaviorally correct, as long-distance drivers depart earlier to complete within the operating window.

---

## 6. Network Assignment

### Routing model

Vehicles know only the network state at their departure time (the Google Maps model — route on current conditions, no foreknowledge of future congestion). Dijkstra is run at departure time with current link speeds; the route is fixed from that point. No time-dependent Dijkstra.

### Loading model

After routing, each vehicle is traced link by link with accumulated travel time. Each link is attributed to the simulation period during which the vehicle actually traverses it — traversal-time loading, not departure-time loading. This means vehicles still in transit from an earlier period contribute to the current period's link flows, which is realistic.

### Period 0

Free-flow speeds. Routes computed from the Dijkstra cache built in the pairing step — no recomputation.

### Period $h > 0$

1. Route all vehicles departing in period $h$ using current link speeds $v_\ell^h$
2. Trace routes; attribute each link to the traversal period
3. Compute link flows $q_\ell^h$ (vehicles per period per link)
4. Update speeds via BPR for period $h+1$:

$$v_\ell^{h+1} = \frac{v_\ell^0}{1 + \alpha \left(\dfrac{q_\ell^h}{Q_\ell}\right)^\beta}$$

Default parameters: $\alpha = 0.15$, $\beta = 4$ (Bureau of Public Roads). Link capacity $Q_\ell$ (vehicles/period) is user-supplied per road type. Re-run Dijkstra with updated weights at the start of each period.

### Output

`loaded_links.gpkg` — one row per (link, period, vehicle type):

| field | description |
|---|---|
| geometry | LineString |
| `road_type`, `grade_pct` | inherited from network |
| `period` | simulation period index |
| `vehicle_type` | vehicle type |
| `n_trips` | vehicles traversing this link in this period |
| `velocity_kmh` | speed used for routing this period (BPR-adjusted) |

---

## 7. Emissions

### Exhaust emissions (COPERT V)

$$\text{EF} \ [\text{g/km}] = \frac{\alpha V^2 + \beta V + \gamma + \delta/V}{\varepsilon V^2 + \zeta V + \eta} \cdot (1 - \text{RF})$$

Factor table keyed by (vehicle type, pollutant, grade pct, load pct). Speed $V$ comes from `velocity_kmh` in the loaded links. Grade is bilinearly interpolated; links with $|\text{grade}| > 6\%$ were excluded at the network level.

### Non-exhaust emissions (EEA EMEP)

Flat g/km per (vehicle type, pollutant). PM only — tyre wear, brake wear, road surface abrasion.

### Emission per (link, period, vehicle type, pollutant)

$$\text{emission\_g} = n_{\text{trips}} \cdot \frac{d_\ell}{1000} \cdot \text{EF}(V, s_\ell, \text{load\_pct})$$

Load pct derivation: TBD.

---

## Open / TBD

- **Agent formation**: exact combination criterion — same link vs. buffer radius; what "same link" means when atoms are at different positions along the link
- **Atom count**: max resource vs. weighted average across resources per stratum
- **Stratum correlation**: same uniform draw for supply and demand stratum assignment vs. independent draws
- **Consolidation location**: centroid of grouped agents vs. largest agent's node
- **Load pct**: derive from actual simulated loads vs. global config parameter
- **KPIs**: not yet specified
