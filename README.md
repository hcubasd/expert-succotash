# expert-succotash

A redesign of the urban-dollop pipeline grounded in canonical transport modelling.
This document is a working scratchpad for the mathematical model.

---

## Overview

The pipeline has four stages:

```
zones.gpkg + population.csv + employment.csv
        │
        ▼
1. Agent Synthesis
   synthesize-households → households.gpkg
   synthesize-organizations → organizations.gpkg
        │
        ▼
2. Resource Supply and Demand
   population_supply/demand.csv + employment_supply/demand.csv
   → resource rates per agent → O_i, A_j per node
        │
        ▼
3. Trip Distribution (Gravity + Furness)
   grade-weighted Dijkstra → c_ij
   Furness → T_ij desire lines → trips.gpkg
        │
        ▼
4. Network Assignment
   Dijkstra per OD pair → loaded_links.gpkg
        │
        ▼
5. Emissions + KPIs
```

Vehicle assignment and consolidation (UCCs, microhubs) sit between stages 3 and 4 and are not yet fully specified.

---

## 1. Agent Synthesis

### Inputs

| file | required fields | notes |
|---|---|---|
| `zones.gpkg` | `zone_id`, polygon geometry | zone boundaries |
| `population.csv` | `zone_id`, stratum cols, `count` | people per stratum per zone |
| `household_sizes.csv` | `zone_id`, `size`, `share` | optional stratum cols |
| `employment.csv` | `zone_id`, stratum cols, `count` | employees per stratum per zone |
| `organization_sizes.csv` | `zone_id`, `size`, `share` | optional stratum cols |
| `network.gpkg` | `road_type`, `grade_pct`, LineString geometry | road network |

Stratum columns in `population.csv` and `employment.csv` are user-defined — any number of demographic or sector dimensions. `household_sizes.csv` and `organization_sizes.csv` join on `zone_id` and any stratum columns they share with the base files; missing stratum columns degenerate to a zone-wide size distribution.

### Depletion algorithm

For each stratum row $(z, s)$ with count $N_{zs}$:

1. Draw household/organization size $k$ from the size distribution for zone $z$ (and stratum $s$ if available) via inverse CDF on the size shares.
2. Place the agent at a uniformly random location within the zone $z$ polygon.
3. Snap the location to the nearest road network node — this node is used for all routing.
4. Assign stratum attributes $s$ to the agent.
5. Decrement $N_{zs} \leftarrow N_{zs} - k$. Repeat from step 1 until $N_{zs} \leq 0$.

Each stratum is depleted independently. The size draw ensures the total synthesized population/employment matches the census count for that stratum.

### Outputs

`households.gpkg` and `organizations.gpkg` — one point feature per synthetic agent, carrying:

| field | description |
|---|---|
| geometry | Point (random location within zone polygon) |
| `node_id` | nearest road network node (for Dijkstra) |
| `size` | number of people (household) or employees (org) |
| stratum cols | inherited from the stratum row |
| `zone_id` | zone this agent belongs to |

---

## 2. Resource Supply and Demand

### Inputs

Four files, all sharing the same stratification schema as `population.csv` / `employment.csv`:

| file | value column(s) |
|---|---|
| `population_supply.csv` | resource rate per person per day |
| `population_demand.csv` | resource rate per person per day |
| `employment_supply.csv` | resource rate per employee per day |
| `employment_demand.csv` | resource rate per employee per day |

Each file has `zone_id`, optional stratum columns, and one column per resource (e.g. `parcels`, `freight_tonnes`, `commutes`). The value is the rate $r$ — how many units of that resource each person or employee in that stratum supplies or demands per day.

### Rate assignment

For synthetic agent $a$ with size $n_a$ in stratum $s$, the supply and demand for resource $q$ are:

$$P_a^q = n_a \cdot r^{\text{supply}}_{s,q}, \qquad A_a^q = n_a \cdot r^{\text{demand}}_{s,q}$$

Rates are looked up by joining on `zone_id` and any stratum columns present in the resource file. Missing stratum columns degenerate to a zone-wide rate.

### Optional: ordered logit for rate generation

When observed rates per stratum are not available but household survey data is, the rate $r_{s,q}$ can be generated via an ordered logit over discrete resource levels $L_0 < L_1 < \cdots < L_K$.

The linear predictor for stratum $s$ is $\eta_s = \sum_d \beta_d \cdot x_{sd}$ where $x_{sd}$ are stratum attribute values and $\beta_d$ are calibrated coefficients. Cumulative probabilities are:

$$P(X \leq L_k) = \frac{1}{1 + \exp(\eta_s - \mu_k)}, \quad k = 0, \ldots, K-1$$

with $P(X \leq L_K) = 1$ by convention. Cell probabilities follow as consecutive differences and the expected rate per person per reference period of $T$ days is:

$$r_s = \frac{1}{T} \sum_k p_k \cdot L_k$$

The logit produces the same scalar $r_s$ that the user would otherwise supply directly — the rest of the pipeline is unchanged.

---

## 3. Trip Distribution — Gravity Model and Furness

### Node-level aggregation

Aggregate supply and demand from agents to their snapped road nodes. For resource $q$:

$$P_i^q = \sum_{a \,:\, \text{node}(a) = i} P_a^q, \qquad A_j^q = \sum_{a \,:\, \text{node}(a) = j} A_a^q$$

### Generalised cost

Travel cost between nodes $i$ and $j$ is computed from grade-weighted time-based Dijkstra (see section 4):

$$c_{ij} = \gamma_t \cdot t_{ij} + \gamma_d \cdot d_{ij}$$

where $t_{ij}$ is travel time in seconds, $d_{ij}$ is distance in metres, and $\gamma_t$, $\gamma_d$ are user-supplied weights that convert time and distance into a single generalised cost. Different resources can use different $\gamma_t$, $\gamma_d$ values.

### Logistic distance decay

$$f(c) = \frac{1}{1 + \exp(\alpha + \beta \ln c)}$$

Parameters $\alpha$ and $\beta$ control the shape of the decay. They are resource-specific and must be calibrated from observed flow data for the study area.

### Furness doubly-constrained gravity model

Before iteration, balance totals so Furness is guaranteed to converge:

$$A_j^q \leftarrow A_j^q \cdot \frac{\sum_i P_i^q}{\sum_j A_j^q}$$

Initialise from the singly-constrained solution (supply constraints satisfied, units in resource units):

$$T_{ij}^{(0)} = P_i \cdot \frac{A_j \cdot f(c_{ij})}{\sum_k A_k \cdot f(c_{ik})}$$

Then iterate until convergence:

1. **Row scaling** — enforce supply constraints:

$$T_{ij} \leftarrow T_{ij} \cdot \frac{P_i}{\sum_j T_{ij}}$$

2. **Column scaling** — enforce demand constraints:

$$T_{ij} \leftarrow T_{ij} \cdot \frac{A_j}{\sum_i T_{ij}}$$

Convergence is declared when $\max_{ij} |T_{ij}^{(n)} - T_{ij}^{(n-1)}| < \varepsilon$ where $\varepsilon$ is one resource unit (e.g. 1 kg, 1 parcel). Entries that round to zero are dropped.

### Output

`resource_flows.gpkg` — one desire line per nonzero $(i, j)$ pair per resource:

| field | description |
|---|---|
| geometry | LineString from node $i$ to node $j$ |
| `resource` | resource name (e.g. `parcels`, `freight_tonnes`) |
| `flow` | $T_{ij}$ rounded to nearest integer unit |

This represents the aggregate daily resource flow between each supply-demand node pair. It is not yet a trip file — vehicle assignment and consolidation follow.

---

## 4. Grade-weighted Time-based Dijkstra

### Network file

`network.gpkg` — one directed LineString per link:

| field | description |
|---|---|
| geometry | 2D LineString |
| `road_type` | e.g. `urban`, `rural`, `highway` |
| `grade_pct` | slope in percent, signed (positive = uphill) |

Speed per road type is user-supplied in config. Distance is derived from geometry length. Grade is a pre-computed attribute (from DEM or user-supplied).

### Edge cost

For link $\ell$ with distance $d_\ell$ (m), road type speed $v_\ell$ (m/s), and grade $s_\ell$ (%):

$$C_\ell = w_1 \cdot \frac{d_\ell}{v_\ell} + w_2 \cdot |s_\ell| \cdot d_\ell$$

$w_1$ and $w_2$ are user-supplied weights. $w_1 = 1$ gives pure travel time in seconds; increasing $w_2$ penalises steep links and routes around grades. Links with $|s_\ell| > 6\%$ are excluded (COPERT V emission factor validity range).

Dijkstra minimises $\sum_{\ell \in \text{path}} C_\ell$ over the directed graph.

### Usage

Dijkstra runs once per unique origin node at simulation startup, caching distances and times to all reachable destination nodes. Results feed both the gravity model ($c_{ij}$ for Furness) and network assignment (actual link-level path for loading).
