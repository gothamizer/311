# Problem/detail combo evaluation snapshot

Generated from `public/data/dashboard-index.json` on 2026-05-29. The build uses 2026-05-27 as the latest complete reporting day.

## What counts as a combo

The dashboard currently treats a top-level 311 `complaint_type` as a problem, and a `complaint_type` + `descriptor` pair as a detail combo. Example:

| Dashboard label | Complaint type | Descriptor/detail |
| --- | --- | --- |
| Snow or Ice / Roadway | Snow or Ice | Roadway |
| Water System / Dirty Water (WE) | Water System | Dirty Water (WE) |
| Street Condition / Pothole | Street Condition | Pothole |

Problem entities and detail entities are evaluated with the same alert-generation machinery, but they do not enter the queue symmetrically. The queue starts from active problem-level evaluations. A detail combo can replace the matching problem row when the detail is also active and strong enough relative to the parent. Active detail combos that do not pass that promotion step remain visible at the entity/detail level but do not become top-level queue rows.

## Current inventory

| Metric | Count |
| --- | ---: |
| Active queue rows | 213 |
| Problem-level queue rows | 208 |
| Promoted detail-level queue rows | 5 |
| Evaluated entities | 405 |
| Evaluated problem entities | 262 |
| Evaluated detail combo entities | 143 |
| Active detail combo entities | 17 |
| Watch detail combo entities | 29 |
| Quiet detail combo entities | 97 |

Main implication: details are being evaluated, but queue promotion is very conservative. Only 5 of 213 queue rows are detail rows, and all 5 are the same combo: `Snow or Ice / Roadway`.

## Queue families

Top active alert families in the current queue:

| Problem | Queue rows | Parent rows | Detail rows | Top priority | Horizons present |
| --- | ---: | ---: | ---: | ---: | --- |
| Snow or Ice | 57 | 52 | 5 | 92 | year |
| Damaged Tree | 15 | 15 | 0 | 94 | 7d, 30d, quarter, year |
| Street Condition | 15 | 15 | 0 | 93 | quarter, year |
| Sewer | 12 | 12 | 0 | 93 | 7d, 30d, quarter |
| Water Conservation | 12 | 12 | 0 | 92 | year |
| Water System | 11 | 11 | 0 | 92 | today, quarter |
| Illegal Fireworks | 7 | 7 | 0 | 90 | today, 7d |
| Noise - Park | 5 | 5 | 0 | 86 | today, 30d, quarter, year |
| Noise - Vehicle | 4 | 4 | 0 | 93 | today |
| Maintenance or Facility | 4 | 4 | 0 | 91 | today, 30d, quarter |
| Lead | 4 | 4 | 0 | 86 | 7d |
| Bus Stop Shelter Complaint | 3 | 3 | 0 | 90 | year |

The queue is still fundamentally a parent-problem queue. That may be right if the dashboard's primary audience wants operational triage at a high level, but it means many plausible detail explanations are being hidden behind parent rows.

## Promoted detail rows

These are the only detail combos currently promoted into the main queue:

| Problem/detail | Geography | Horizon | Priority | Actual | Expected | Deviation | Horizon score |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Snow or Ice / Roadway | Citywide | year | 92 | 11,457 | 814 | +1307.5% | 13.6 |
| Snow or Ice / Roadway | Queens | year | 92 | 3,667 | 122 | +2905.7% | 13.1 |
| Snow or Ice / Roadway | Staten Island | year | 92 | 2,990 | 354 | +744.6% | 13.7 |
| Snow or Ice / Roadway | Bronx | year | 91 | 1,509 | 93 | +1522.6% | 15.7 |
| Snow or Ice / Roadway | Manhattan | year | 90 | 621 | 52 | +1094.2% | 13.5 |

This is useful as a precision improvement over a generic `Snow or Ice` row, but it is also a warning sign: the only details that surface are those that can compete with a very strong parent row on queue priority. Other details can look analytically important and still be absent from the queue.

## Active detail combos not promoted

These detail entities are internally active, but are not currently top-level queue rows. The `Best geography` values below come from the detail entity's geography breakdown.

| Problem/detail | Default horizon | Entity score | Active detail alerts | Best geography | Geo priority | Actual | Expected | Deviation |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| Snow or Ice / Snow Tracking | year | 750.9 | 2 | Citywide | 45 | 14,579 | 267 | +5360.3% |
| Snow or Ice / Pedestrian Feature | year | 494.7 | 6 | Citywide | 68 | 2,095 | 17 | +12223.5% |
| Noise / Noise: Manufacturing Noise (NK1) | year | 103.6 | 4 | Citywide | 95 | 871 | 108 | +706.5% |
| Snow or Ice / Bike Lane | year | 68.5 | 1 | Citywide | 67 | 155 | 4 | +3775.0% |
| Water System / Hydrant Running Full (WA4) | quarter | 35.1 | 3 | Citywide | 95 | 1,559 | 569 | +174.0% |
| Snow or Ice / Sidewalk | year | 25.4 | 4 | Bronx | 69 | 2,718 | 745 | +264.8% |
| Water System / Possible Water Main Break (WA1) | quarter | 22.5 | 2 | Citywide | 97 | 1,137 | 425 | +167.5% |
| Water System / Dirty Water (WE) | quarter | 19.5 | 1 | Bronx | 95 | 274 | 82 | +234.1% |
| Water System / Leak (WA2) | quarter | 17.7 | 1 | Brooklyn | 96 | 774 | 248 | +212.1% |
| Street Condition / Line/Marking - Faded | quarter | 17.2 | 1 | Citywide | 95 | 187 | 33 | +466.7% |
| Water System / No Water (WNW) | year | 16.3 | 3 | Citywide | 96 | 3,495 | 1,254 | +178.7% |
| Water System / Excessive Water In Basement (WEFB) | year | 15.4 | 1 | Queens | 93 | 254 | 89 | +185.4% |
| Street Condition / Pothole | year | 15.2 | 4 | Citywide | 97 | 48,286 | 17,500 | +175.9% |

This table is probably the best evidence for changing the product behavior. Several detail combos have high priorities and intuitive public-sector meaning, but the main queue still shows parent categories like `Water System` or `Street Condition`.

## Detail coverage by parent problem

| Parent problem | Evaluated details | Active | Watch | Quiet | Max detail score |
| --- | ---: | ---: | ---: | ---: | ---: |
| Water System | 23 | 6 | 5 | 12 | 35.1 |
| Snow or Ice | 5 | 5 | 0 | 0 | 750.9 |
| Street Condition | 26 | 2 | 6 | 18 | 17.2 |
| Noise | 18 | 2 | 2 | 14 | 103.6 |
| Illegal Parking | 18 | 1 | 4 | 13 | 6.6 |
| Noise - Street/Sidewalk | 9 | 1 | 1 | 7 | 6.1 |
| Plumbing | 8 | 0 | 2 | 6 | 10.5 |
| Dirty Condition | 6 | 0 | 2 | 4 | 8.3 |
| Noise - Commercial | 7 | 0 | 2 | 5 | 5.6 |
| Heat/Hot Water | 2 | 0 | 2 | 0 | 4.6 |

## Evaluation questions

1. Should the queue be problem-first with detail substitution, as it is now, or should active detail combos be eligible as first-class queue rows?
2. If details become first-class rows, should we suppress the matching parent row to avoid duplicate alerts, or show a grouped parent row with expandable detail contributors?
3. Should detail combos be evaluated at community-board geography too? Today they are limited to citywide and borough-level views, while parent problems can surface at community-board level.
4. Should some parent categories always prefer details when a detail is available? `Water System`, `Street Condition`, `Noise`, and `Snow or Ice` are all broad labels where the descriptor often carries the operational meaning.
5. Should detail promotion use the same priority formula as parent alerts, or a detail-specific formula that rewards explanatory specificity more heavily?

My read from this snapshot: details should probably be first-class analytical entities, but the user-facing queue should avoid raw parent/detail duplication. A good holistic direction would be a grouped queue: one row per problem/geography/horizon, with the row label choosing the most explanatory level and an inline contributor list when multiple details are active.
