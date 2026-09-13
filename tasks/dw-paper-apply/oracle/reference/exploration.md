# SPE 162910 applied — reference round

## O1 — Exponential fit of NM well 30-005-00228: Di 0.002676 per month over its first 48 months

An exponential least-squares fit on log oil rate over the first 48 months of well 30-005-00228 gives Di_per_month = 0.002676 and qi_fit = 140.46 bbl/month.

```sql
select months_on_production, total_oil_bbl from decline_curve_inputs where entity_key = '30-005-00228' and months_on_production <= 48 order by months_on_production limit 48
```

## O2 — Exponential fit of NM well 30-005-00274: Di 0.007961 per month over its first 48 months

An exponential least-squares fit on log oil rate over the first 48 months of well 30-005-00274 gives Di_per_month = 0.007961 and qi_fit = 636.84 bbl/month.

```sql
select months_on_production, total_oil_bbl from decline_curve_inputs where entity_key = '30-005-00274' and months_on_production <= 48 order by months_on_production limit 48
```

## O3 — Exponential fit of NM well 30-005-00342: Di 0.007806 per month over its first 48 months

An exponential least-squares fit on log oil rate over the first 48 months of well 30-005-00342 gives Di_per_month = 0.007806 and qi_fit = 336.68 bbl/month.

```sql
select months_on_production, total_oil_bbl from decline_curve_inputs where entity_key = '30-005-00342' and months_on_production <= 48 order by months_on_production limit 48
```

## O4 — Exponential fit of NM well 30-005-00433: Di -0.029422 per month over its first 48 months

An exponential least-squares fit on log oil rate over the first 48 months of well 30-005-00433 gives Di_per_month = -0.029422 and qi_fit = 1117.15 bbl/month.

```sql
select months_on_production, total_oil_bbl from decline_curve_inputs where entity_key = '30-005-00433' and months_on_production <= 48 order by months_on_production limit 48
```

## O5 — Exponential fit of NM well 30-005-00519: Di 0.01094 per month over its first 48 months

An exponential least-squares fit on log oil rate over the first 48 months of well 30-005-00519 gives Di_per_month = 0.01094 and qi_fit = 1055.58 bbl/month.

```sql
select months_on_production, total_oil_bbl from decline_curve_inputs where entity_key = '30-005-00519' and months_on_production <= 48 order by months_on_production limit 48
```

## Next questions

- Fit the power-law exponential model to the same five wells and compare residuals with the exponential fit.
- Do TX well-level and lease-level rows for one lease give different fitted declines?
