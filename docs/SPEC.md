# 311 Complaint Anomaly Dashboard

## Final specification

## 1. Product purpose

This dashboard is a **current-anomaly surveillance system for complaint data**. Its only job is to decide which complaint patterns are worth attention **now**, rank them, and open on the chart and geography view that make the anomaly visually obvious. It is not a general trend portal, not a service-closure dashboard, and not a historical anomaly archive. NYC’s official 311 reporting site already covers monthly and fiscal-year-to-date counts with trend drilldowns up to four years, and the State Comptroller’s NYC311 Monitoring Tool already covers monthly neighborhood complaint activity. The product gap is a system that continuously evaluates the live complaint panel and surfaces the most important **current** anomalies in one prioritized queue.

The design targets NYC 311, but the same architecture can be reused for other large panel event-count systems such as 911.

## 2. Data scope and scoring universe

The source of truth is the official NYC Open Data request-level feed, using both **311 Service Requests from 2020 to Present** and **311 Service Requests from 2010 to 2019**. Those datasets are updated daily. In late 2025, the public schema was revised so the visible labels became **Problem**, **Problem Detail**, and **Additional Details**, while the backend API field names remained `complaint_type`, `descriptor`, and `descriptor_2`; the data was also split into two ten-year tables because the live table had grown beyond 40 million rows. NYC311 says it accepts more than 500 service-request types, which makes aggressive alert prioritization a first-class requirement rather than a nice-to-have.

The primary scoring universe is:

* **Problem × geography**
* geographies: **citywide, borough, community board**

The secondary scoring universe is:

* **Problem Detail × geography**
* same geography set

Problem Detail is scored because some anomalies are only obvious at that level, but the main queue does not surface every child series independently. It surfaces the level that best explains the anomaly.

Community board is the default local geography because the City’s own 311 Service Request Maps already use **Community District** as the default mapped local view, with Borough, Council District, and ZIP Code as alternatives.

## 3. User-facing product structure

The interface has **one main anomaly pane** and **four fixed-horizon panes**.

The main anomaly pane is the homepage. It is a ranked queue of current alerts. The user should never need to parse anomaly-detector jargon or choose a time scale before understanding what is happening. Every alert card must answer, in one glance:

* what category is odd
* where it is odd
* over what horizon it is odd
* how large the deviation is
* why the system thinks it matters

The fixed-horizon panes are:

* **7 days**
* **30 days**
* **Quarter**
* **Year**

Those panes are ranked but exhaustive. They exist for policymakers who want to inspect the panel through one chosen horizon rather than rely on the fused anomaly queue.

A searchable category explorer sits alongside them. Any Problem or Problem Detail can be opened directly, whether or not it is currently alerting.

## 4. Conceptual approach

The dashboard uses a **multi-horizon surveillance stack** under the hood, but collapses everything into one user-facing judgment.

That stack is built from standard process-monitoring tools rather than bespoke forecasting per metric. In the time-series literature, the relevant problem is real-time **surveillance** rather than retrospective mining of weird past intervals. In SPC terms, the classical toolkit is: point-limit checks for abrupt shocks, EWMA for gradual persistent shifts, and CUSUM for sustained departures that are too small to trip a simple point rule. That is the right base here. The dashboard adds one more ingredient: period-to-date pacing for quarter and year views, because policymakers care about whether the current quarter or year is shaping up to be unusually bad even if no single day looks extreme.

The user does **not** see this detector stack. The user sees one alert with one chosen horizon and one plain-English explanation.

## 5. Comparable history

Every scored series gets an **effective comparable-history start date**. Past data before that date is not used as if it were fully comparable to the present series definition.

For v1, comparability is intentionally conservative and simple:

* use exact-label history only
* do not infer predecessor/successor mappings across renamed or split categories
* truncate history at the latest of:

  * first appearance of the exact Problem or Problem Detail
  * an official taxonomy-change date if known
  * an accepted structural break

This is necessary because the dataset documentation explicitly warns that expected values for many fields can change over time, and the City is required to report added or updated 311 request types annually. In other words, taxonomy and valid field values are not static. ([NYC Open Data][1])

A structural break is accepted when a robust changepoint pass on `log1p(daily_count)` finds a persistent shift meeting both conditions:

* minimum segment length: **56 days**
* material change: median level shift of at least **35%**, or zero-rate shift of at least **25 percentage points**, persisting for at least **8 weeks**

This rule is deliberately conservative. It prevents the dashboard from resetting its own history every time a category has one noisy month.

## 6. Series preparation

For each series (s) on day (t), let (y_{s,t}) be the daily complaint count and define

[
x_{s,t} = \log(1 + y_{s,t})
]

The system estimates an expected value (\hat{x}_{s,t}) from three components:

[
\hat{x}*{s,t} = \text{local level}*{s,t} + \text{weekly pattern}*{s,t} + \text{annual pattern}*{s,t}
]

The weekly pattern is active only when the series has at least **84 comparable days** and a meaningful day-of-week effect. The annual pattern is active only when the series has at least **730 comparable days**. Both seasonal terms are estimated with recent-weighted robust medians rather than hand-tuned forecasting models.

The local level is estimated causally with a **Huberized EWMA** so that the baseline can adapt without immediately absorbing large outliers. Residual scale is estimated with a rolling **MAD**.

The common residual currency for all detectors is

[
r_{s,t} = \frac{x_{s,t} - \hat{x}*{s,t}}{\hat{\sigma}*{s,t}}
]

where (\hat{\sigma}_{s,t}) is the robust rolling residual scale.

Sparse series are handled simply. If a series has fewer than **56 comparable days**, or more than **50% zero days**, or mean daily count below **1.0**, the “today” detector is disabled and the series is treated at weekly aggregation for ranking purposes.

## 7. The five scored horizons

The engine evaluates five horizons and assigns each series one dominant current horizon.

### Today

This is the abrupt-shock horizon.

[
H_{1}(s,t) = |r_{s,t}|
]

It answers: did today jump or drop sharply relative to what today should have looked like after calendar adjustment?

### 7 days

This is the recent-burst horizon.

[
H_{7}(s,t) =
\max\left(
\frac{\left|\sum_{i=t-6}^{t} r_{s,i}\right|}{\sqrt{7}},
|\text{EWMA}*{7}(r)*{s,t}|,
|\text{CUSUM}*{7}(r)*{s,t}|
\right)
]

It answers: has the last week been unusually high or low, either as one burst or as a short sustained run?

### 30 days

This is the medium-run horizon.

[
H_{30}(s,t) =
\max\left(
\frac{\left|\sum_{i=t-29}^{t} r_{s,i}\right|}{\sqrt{30}},
|\text{EWMA}*{30}(r)*{s,t}|,
|\text{CUSUM}*{30}(r)*{s,t}|
\right)
]

It answers: has the last month-like window shifted into a meaningfully different regime?

### Quarter

This is the current-period horizon for calendar quarters.

[
H_{Q}(s,t) =
\max\left(
\text{tail score of quarter-to-date cumulative residual},
\text{tail score of projected quarter-end total}
\right)
]

The projected quarter finish uses current normalized pace plus the expected seasonal remainder of the quarter. The quarter horizon is active only when there are at least **365 comparable days**.

### Year

This is the current-period horizon for the calendar year.

[
H_{Y}(s,t) =
\max\left(
\text{tail score of year-to-date cumulative residual},
\text{tail score of projected year-end total}
\right)
]

The year horizon is active only when there are at least **730 comparable days**.

### Pattern-break modifier

A narrow pattern-break check runs in the background but is **not** a separate user-facing alert class.

When a series has a strong admitted weekly or annual pattern, the system measures whether the recent shape of that pattern has become abnormally flat, abnormally amplified, or otherwise distorted. If that score is large, it is attached to the relevant horizon:

* weekly-pattern break contributes to **7-day**
* annual-pattern break contributes to **Year**

This is how the system catches the kind of chart a human reads as “the usual weekly rhythm is missing” without forcing the user to learn a separate anomaly taxonomy.

## 8. One alert per series, not one detector per series

For each series, the dashboard selects a **single dominant active horizon**:

[
H^**{s,t} = \max(H_1, H_7, H*{30}, H_Q, H_Y)
]

That horizon determines:

* the headline explanation
* the default chart scale
* the key comparison numbers
* the sort order in the main anomaly queue

Secondary signals are kept as tags, not promoted to independent main-feed alerts.

A series can therefore surface as:

* **Today spike**
* **7-day run-up**
* **30-day shift**
* **Quarter running unusually high**
* **Year on pace for an unusually bad finish**

Those are the user-facing narratives. The user does not see EWMA, CUSUM, residual z-scores, or detector internals.

## 9. Alert ranking

The home queue is sorted by **priority**, not by raw statistical severity alone.

Each candidate alert gets a 0–100 priority score:

[
P = 0.45 \cdot \text{severity}

* 0.25 \cdot \text{impact}
* 0.15 \cdot \text{persistence}
* 0.10 \cdot \text{breadth}
* 0.05 \cdot \text{specificity}

- \text{artifact penalty}
  ]

Definitions:

* **severity**: normalized strength of the dominant horizon score
* **impact**: excess complaint volume on the dominant horizon
* **persistence**: how consistently elevated the signal has remained
* **breadth**: whether the same Problem is also elevated in related geographies
* **specificity**: whether the system can explain the anomaly at a more specific Problem Detail level
* **artifact penalty**: reductions for likely data or taxonomy artifacts

Default queueing rule:

* main queue eligible if:

  * dominant horizon severity is at least **4.5** in z-like units, or
  * two horizons each exceed **3.5**, or
  * projected quarter/year finish lands in the top or bottom **2%** of comparable history
* home queue shows all current active alerts in priority order
* lower-priority “watch” items appear only in the fixed-horizon panes and category explorer

The main pane remains ordered by priority, while eligibility rules keep low-signal watch items out of the active queue.

## 10. Taxonomy and artifact handling

The system attaches artifact flags but does not usually suppress alerts outright.

The default artifact flags are:

* **Limited history**: not enough comparable history for full seasonal or long-horizon reasoning
* **Possible taxonomy artifact**: sibling Problem Details suddenly reallocate share while the parent total stays roughly stable
* **Panel-wide break**: an unusually large fraction of the scored universe trips a shock rule on the same date, suggesting ingestion or system-wide classification effects

Artifact penalties are:

* limited history: **–10**
* possible taxonomy artifact: **–15**
* panel-wide break: **–20**

A flagged anomaly can still reach the queue if it is strong enough, but it will be ranked lower and labeled clearly.

## 11. Parent-child merging

The queue must not be flooded by both a parent and its child telling the same story.

Scoring runs at both **Problem** and **Problem Detail** levels. The surfaced level follows this rule:

* show **Problem Detail** if it explains at least **60%** of the parent’s recent 30-day excess and has at least **80%** of the parent’s priority score
* otherwise show **Problem** and list the leading Problem Details as tags

This preserves specificity when it helps, but avoids clutter when several children are jointly driving the same parent-level anomaly.

## 12. Geography merging

The queue must also avoid citywide/local duplicates.

If the same Problem is alerting citywide and in multiple subordinate geographies, the main queue prefers the **highest informative roll-up**:

* show the citywide card if the citywide priority is high and the anomaly is broad
* show a local geography card only when the local signal is materially stronger or tells a different story
* subordinate geographies remain visible in the detail page and fixed-horizon panes

This keeps the home queue short and readable.

## 13. Alert lifecycle

The dashboard tracks only **active** anomalies.

Resolution rules:

* **Today** alerts resolve after **2 quiet days**
* **7-day** and **30-day** alerts resolve after **7 days below watch threshold**
* **Quarter** and **Year** alerts resolve at period end or when projected finish returns to a non-extreme range

There is no historical anomaly archive in the main product. Past data appears only as comparison context inside charts.

## 14. Main anomaly pane

The main pane is the front door. Each alert card contains:

* headline: category and geography
* horizon badge: Today / 7 days / 30 days / Quarter / Year
* one-sentence explanation
* actual vs expected
* percent difference
* projected finish percentile, when applicable
* artifact tags
* a sparkline already set to the right time scale

A model card should read like this:

**Residential Noise — Bronx Community Board 7**
**7 days**
Last 7 days: **412 complaints vs 275 expected** (**+50%**)
This is a short-run surge, not a routine weekly peak.
Also on pace for an unusually high quarter.

The user should understand the anomaly before opening the detail page.

## 15. Detail page

Clicking an alert opens a detail page designed to make the anomaly visually self-evident.

The system chooses the default chart automatically:

* **Today**: last **8 weeks** of daily counts with expected band and current point highlighted
* **7 days**: last **6 months** with rolling 7-day actual vs expected
* **30 days**: last **18 months** with rolling 30-day actual vs expected
* **Quarter**: current quarter-to-date cumulative actual vs expected, plus prior comparable quarters
* **Year**: current year-to-date cumulative actual vs expected, plus prior years and projected finish

Every detail page also includes:

* a map of the same Problem across community boards for the active horizon
* leading Problem Detail contributors
* a short artifact explanation if any flag is present
* quick switches to the four fixed horizon tabs for the same category

The chart should always open on the horizon that best explains **why this alert exists**.

## 16. Fixed-horizon panes

The fixed panes are:

* **7 days**
* **30 days**
* **Quarter**
* **Year**

Each pane is ranked and exhaustive. These are not secondary alert systems; they are systematic ranked views of the same scored universe through one chosen horizon.

Each row shows:

* category
* geography
* actual vs expected on that horizon
* percent difference
* historical tail percentile or projected finish percentile
* mini-sparkline
* artifact tags

These panes support policy users who want to browse “what is high this quarter” or “what is on pace for an extreme year” without relying on the fused queue.

Calendar quarter and calendar year should be the defaults. A fiscal-year toggle can be added because the City’s official reporting surface is FYTD-oriented.

## 17. Category explorer

The category explorer is separate from the queue.

The user can search any Problem or Problem Detail and open a standardized page showing:

* current anomaly status
* all four fixed-horizon scores
* default anomaly chart
* horizon switches
* geography breakdown

This allows exhaustive inspection without expanding the main queue into an unmanageable list.

## 18. Pipeline

The pipeline runs once daily after the official dataset refresh.

1. Ingest both official request-level datasets.
2. Normalize taxonomy and geography fields.
3. Update comparable-history boundaries.
4. Aggregate daily counts by scored series.
5. Recompute seasonal templates and local baselines for affected series.
6. Compute horizon scores, artifact flags, and priority.
7. Merge parent-child and geography duplicates.
8. Publish the main queue, fixed-horizon panes, and category pages.

Because the official datasets update daily and the public reporting surfaces are already separately maintained, this pipeline should be treated as a lightweight daily surveillance layer on top of the raw complaint feed rather than as a replacement for the City’s official reporting views.

## 19. Locked defaults

The v1 defaults are:

* primary queue universe: **Problem × citywide / borough / community board**
* secondary scored universe: **Problem Detail × same geographies**
* exact-label history only; no inferred lineage
* daily scoring with weekly fallback for sparse series
* weekly seasonality active at **84+ comparable days**
* annual seasonality active at **730+ comparable days**
* long-horizon eligibility:

  * 7-day and 30-day require **56+ comparable days**
  * Quarter requires **365+ comparable days**
  * Year requires **730+ comparable days**
* structural-break reset:

  * minimum segment **56 days**
  * accepted only for persistent material shifts
* main queue cap: **25 active alerts**
* queue threshold:

  * one strong signal, or
  * two moderate signals, or
  * extreme projected quarter/year finish
* artifact flags demote but do not suppress by default
* no historical anomaly archive
* no fulfillment or closure metrics in v1
