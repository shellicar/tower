//! Display policy: per-model $/token rates and context windows — the
//! derivations towerd deliberately does not ship ($ and %). towerd ships
//! facts (token totals incl. the 5m/1h cache-creation split, the latest
//! turn's context size and model); the price table and the window are the
//! client's, ported verbatim (numbers and behaviour) from mvp/frontend's
//! core/pricing.ts so the two frontends show the same dollar figure for the
//! same conversation.
//!
//! Cache-creation is priced by its 5m/1h split at each TTL's own write rate.
//! The bridge writes 1h caches today, so in practice the 1h column carries
//! it — but the split is priced honestly, not assumed, so a mixed producer
//! prices right too.

use ws_types::WsUsage;

const M: f64 = 1_000_000.0;

#[derive(Debug, Clone, Copy)]
struct ModelRates {
    input: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
    cache_read: f64,
    output: f64,
    context_window: i64,
}

const fn r(
    input: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
    cache_read: f64,
    output: f64,
    context_window: i64,
) -> ModelRates {
    ModelRates { input, cache_write_5m, cache_write_1h, cache_read, output, context_window }
}

static FABLE: &[(&str, ModelRates)] =
    &[("claude-fable-5", r(10.0 / M, 12.5 / M, 20.0 / M, 1.0 / M, 50.0 / M, 1_000_000))];

static OPUS: &[(&str, ModelRates)] = &[
    ("claude-opus-3", r(15.0 / M, 18.75 / M, 30.0 / M, 1.5 / M, 75.0 / M, 200_000)),
    ("claude-opus-4", r(15.0 / M, 18.75 / M, 30.0 / M, 1.5 / M, 75.0 / M, 200_000)),
    ("claude-opus-4-1", r(15.0 / M, 18.75 / M, 30.0 / M, 1.5 / M, 75.0 / M, 200_000)),
    ("claude-opus-4-5", r(5.0 / M, 6.25 / M, 10.0 / M, 0.5 / M, 25.0 / M, 200_000)),
    ("claude-opus-4-6", r(5.0 / M, 6.25 / M, 10.0 / M, 0.5 / M, 25.0 / M, 1_000_000)),
    ("claude-opus-4-7", r(5.0 / M, 6.25 / M, 10.0 / M, 0.5 / M, 25.0 / M, 1_000_000)),
    ("claude-opus-4-8", r(5.0 / M, 6.25 / M, 10.0 / M, 0.5 / M, 25.0 / M, 1_000_000)),
];

static SONNET: &[(&str, ModelRates)] = &[
    ("claude-sonnet-3-7", r(3.0 / M, 3.75 / M, 6.0 / M, 0.3 / M, 15.0 / M, 200_000)),
    ("claude-sonnet-4", r(3.0 / M, 3.75 / M, 6.0 / M, 0.3 / M, 15.0 / M, 1_000_000)),
    ("claude-sonnet-4-5", r(3.0 / M, 3.75 / M, 6.0 / M, 0.3 / M, 15.0 / M, 1_000_000)),
    ("claude-sonnet-4-6", r(3.0 / M, 3.75 / M, 6.0 / M, 0.3 / M, 15.0 / M, 1_000_000)),
    ("claude-sonnet-5", r(3.0 / M, 3.75 / M, 6.0 / M, 0.3 / M, 15.0 / M, 1_000_000)),
];

static HAIKU: &[(&str, ModelRates)] = &[
    ("claude-haiku-3", r(0.25 / M, 0.3 / M, 0.5 / M, 0.03 / M, 1.25 / M, 200_000)),
    ("claude-haiku-3-5", r(0.8 / M, 1.0 / M, 1.6 / M, 0.08 / M, 4.0 / M, 200_000)),
    ("claude-haiku-4-5", r(1.0 / M, 1.25 / M, 2.0 / M, 0.1 / M, 5.0 / M, 200_000)),
];

/// Each family in release order, newest at the tail — position encodes
/// recency. An unknown model in a known family resolves to the tail.
static FAMILIES: &[(&str, &[(&str, ModelRates)])] =
    &[("fable", FABLE), ("opus", OPUS), ("sonnet", SONNET), ("haiku", HAIKU)];

/// No rates (cost reads 0, not NaN) and the common window.
const UNKNOWN: ModelRates =
    ModelRates { input: 0.0, cache_write_5m: 0.0, cache_write_1h: 0.0, cache_read: 0.0, output: 0.0, context_window: 200_000 };

fn strip_date_suffix(model: &str) -> &str {
    // `-YYYYMMDD` at the end, 8 ascii digits.
    let bytes = model.as_bytes();
    if bytes.len() > 9
        && bytes[bytes.len() - 9] == b'-'
        && bytes[bytes.len() - 8..].iter().all(u8::is_ascii_digit)
    {
        &model[..model.len() - 9]
    } else {
        model
    }
}

fn resolve_rates(model: &str) -> ModelRates {
    let stripped = strip_date_suffix(model);
    for (_, entries) in FAMILIES {
        for (id, rates) in *entries {
            if *id == model || *id == stripped {
                return *rates;
            }
        }
    }
    for (family, entries) in FAMILIES {
        if stripped.starts_with(&format!("claude-{family}-")) {
            return entries[entries.len() - 1].1; // an unknown model resolves to the newest
        }
    }
    UNKNOWN
}

pub struct PricedUsage {
    pub cost_usd: f64,
    /// The current prompt's occupancy of the window (the latest turn's context).
    pub context_used: i64,
    pub context_max: i64,
    /// 0..100.
    pub context_pct: f64,
}

pub fn price_usage(u: &WsUsage) -> PricedUsage {
    let r = resolve_rates(&u.model);
    // Price cache-creation by its 5m/1h split, each at its own write rate.
    // When the producer sent no split (both 0 but a non-zero total), fall
    // back to the 1h rate — the bridge writes 1h caches, so that is the
    // honest assumption.
    let split = u.cache_creation_5m_tokens + u.cache_creation_1h_tokens;
    let cache_creation_cost = if split > 0 {
        u.cache_creation_5m_tokens as f64 * r.cache_write_5m
            + u.cache_creation_1h_tokens as f64 * r.cache_write_1h
    } else {
        u.cache_creation_tokens as f64 * r.cache_write_1h
    };
    let cost_usd = u.input_tokens as f64 * r.input
        + cache_creation_cost
        + u.cache_read_tokens as f64 * r.cache_read
        + u.output_tokens as f64 * r.output;
    let context_max = r.context_window;
    let context_pct = if context_max > 0 {
        (u.context_tokens as f64 / context_max as f64) * 100.0
    } else {
        0.0
    };
    PricedUsage { cost_usd, context_used: u.context_tokens, context_max, context_pct }
}

/// Compact token count: 9700 → "9.7k", 2_100_000 → "2.1M", 512 → "512".
pub fn format_tokens(n: i64) -> String {
    if n < 1_000 {
        format!("{n}")
    } else if (n as f64) < M {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        format!("{:.1}M", n as f64 / M)
    }
}

/// The dollar cost, four decimals — matches the SC's TUI ("$64.4029").
pub fn format_usd(n: f64) -> String {
    format!("${n:.4}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(over: impl FnOnce(&mut WsUsage)) -> WsUsage {
        let mut u = WsUsage {
            conv: "c1".into(),
            model: "claude-sonnet-4-5".into(),
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_creation_5m_tokens: 0,
            cache_creation_1h_tokens: 0,
            cache_read_tokens: 0,
            turns: 0,
            context_tokens: 0,
        };
        over(&mut u);
        u
    }

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "{a} != {b}");
    }

    #[test]
    fn prices_the_5m_1h_cache_creation_split_at_each_ttl_own_write_rate() {
        let u = usage(|u| {
            u.cache_creation_tokens = 2_000_000;
            u.cache_creation_5m_tokens = 1_000_000;
            u.cache_creation_1h_tokens = 1_000_000;
        });
        close(price_usage(&u).cost_usd, 3.75 + 6.0);
    }

    #[test]
    fn with_no_split_reported_prices_the_whole_total_at_the_1h_rate() {
        let u = usage(|u| {
            u.input_tokens = 1_000_000;
            u.cache_creation_tokens = 1_000_000;
            u.cache_read_tokens = 1_000_000;
            u.output_tokens = 1_000_000;
        });
        close(price_usage(&u).cost_usd, 3.0 + 6.0 + 0.3 + 15.0);
    }

    #[test]
    fn takes_the_context_window_from_the_model_and_computes_the_percentage() {
        let u = usage(|u| u.context_tokens = 500_000);
        let p = price_usage(&u);
        assert_eq!(p.context_max, 1_000_000);
        close(p.context_pct, 50.0);
    }

    #[test]
    fn resolves_an_unknown_model_in_a_known_family_to_the_newest() {
        let u = usage(|u| {
            u.model = "claude-sonnet-9".into();
            u.context_tokens = 200_000;
        });
        assert_eq!(price_usage(&u).context_max, 1_000_000);
    }

    #[test]
    fn strips_a_date_suffix_before_lookup() {
        let u = usage(|u| {
            u.model = "claude-opus-4-1-20250805".into();
            u.context_tokens = 100_000;
        });
        assert_eq!(price_usage(&u).context_max, 200_000);
    }

    #[test]
    fn an_unknown_family_costs_nothing_and_falls_back_to_a_200k_window() {
        let u = usage(|u| {
            u.model = "gpt-something".into();
            u.input_tokens = 1_000_000;
            u.context_tokens = 100_000;
        });
        let p = price_usage(&u);
        assert_eq!(p.cost_usd, 0.0);
        assert_eq!(p.context_max, 200_000);
    }

    #[test]
    fn compacts_token_counts() {
        assert_eq!(format_tokens(512), "512");
        assert_eq!(format_tokens(9_700), "9.7k");
        assert_eq!(format_tokens(2_100_000), "2.1M");
    }

    #[test]
    fn shows_the_dollar_cost_to_four_decimals() {
        assert_eq!(format_usd(64.4029), "$64.4029");
    }
}
