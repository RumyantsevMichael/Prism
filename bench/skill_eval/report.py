#!/usr/bin/env python3
"""Report paired direct Prism skill A/B evaluation results."""

from __future__ import annotations

import argparse
import json
import random
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


RESAMPLES = 10_000
METRICS = (
    ("pass_rate", "Pass rate", True),
    ("assertion_rate", "Assertion rate", True),
    ("critical_failures", "Critical failures", False),
    ("tokens", "Tokens", False),
    ("cost_usd", "Cost USD", False),
    ("turns", "Turns", False),
    ("duration_s", "Duration s", False),
)
QUALITY_METRICS = {"pass_rate", "assertion_rate", "critical_failures"}
PAIR_FIELDS = ("skill", "agent", "model", "seed", "mock", "seed_snapshot")
TOKEN_FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens")


def load_records(paths: list[str]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for raw_path in paths:
        path = Path(raw_path)
        if path.is_dir():
            path = path / "results.jsonl"
        for line in path.read_text().splitlines():
            if line.strip():
                record = json.loads(line)
                record.setdefault("skill", "write-adr")
                records.append(record)
    return records


def metric(record: dict[str, object], name: str) -> float | None:
    score = record["score"]
    if name == "pass_rate":
        return float(bool(score["passed"]))
    if name in {"assertion_rate", "critical_failures"}:
        return float(score[name])
    if name == "tokens":
        usage = record.get("usage") or {}
        return float(sum(usage.get(field) or 0 for field in TOKEN_FIELDS))
    if name == "cost_usd" and record.get(name) is None:
        return None
    return float(record.get(name) or 0.0)


def paired_records(records: list[dict[str, object]]) -> dict[tuple[str, int], dict[str, dict[str, object]]]:
    pairs: dict[tuple[str, int], dict[str, dict[str, object]]] = defaultdict(dict)
    for record in records:
        key = (str(record["scenario"]), int(record["rep"]))
        arm = str(record["arm"])
        if arm in pairs[key]:
            raise SystemExit(f"duplicate record for {key[0]} rep {key[1]} arm {arm}")
        pairs[key][arm] = record
    incomplete = [key for key, arms in pairs.items() if set(arms) != {"original", "candidate"}]
    if incomplete:
        raise SystemExit(f"incomplete pairs: {incomplete}")
    for key, arms in pairs.items():
        mismatched = [
            field
            for field in PAIR_FIELDS
            if arms["original"].get(field) != arms["candidate"].get(field)
        ]
        if mismatched:
            raise SystemExit(
                f"mismatched pair for {key[0]} rep {key[1]}: {', '.join(mismatched)}"
            )
    return dict(pairs)


def scenario_deltas(
    pairs: dict[tuple[str, int], dict[str, dict[str, object]]], name: str
) -> dict[str, float]:
    grouped: dict[str, list[float]] = defaultdict(list)
    for (scenario, _), arms in pairs.items():
        if name not in QUALITY_METRICS and any(arm.get("error") for arm in arms.values()):
            continue
        candidate = metric(arms["candidate"], name)
        original = metric(arms["original"], name)
        if candidate is None or original is None:
            continue
        grouped[scenario].append(candidate - original)
    return {scenario: statistics.mean(values) for scenario, values in grouped.items()}


def bootstrap_interval(values: list[float], seed: int, resamples: int) -> tuple[float, float, float]:
    if not values:
        raise ValueError("no paired values")
    rng = random.Random(seed)
    samples = sorted(
        statistics.mean(rng.choice(values) for _ in values) for _ in range(resamples)
    )
    low = samples[int(0.025 * resamples)]
    high = samples[min(resamples - 1, int(0.975 * resamples))]
    return statistics.mean(values), low, high


def generate(records: list[dict[str, object]], seed: int, resamples: int) -> str:
    if not records:
        raise SystemExit("no records found")
    skills = {str(record.get("skill", "write-adr")) for record in records}
    if len(skills) != 1:
        raise SystemExit(f"mixed tested skills: {', '.join(sorted(skills))}")
    skill = next(iter(skills))
    for arm in ("original", "candidate"):
        hashes = {
            record.get("plugin_skill_sha256")
            for record in records
            if record.get("arm") == arm
        }
        if len(hashes) != 1 or not all(
            isinstance(value, str) and value for value in hashes
        ):
            raise SystemExit(
                f"expected one plugin_skill_sha256 for {arm} arm, found: "
                f"{sorted(str(value) for value in hashes)}"
            )
    pairs = paired_records(records)
    scenarios = sorted({key[0] for key in pairs})
    reps = sorted({key[1] for key in pairs})
    lines = [
        f"# Direct {skill} A/B report",
        "",
        f"- Generated: {datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        f"- Complete pairs: {len(pairs)} across {len(scenarios)} scenarios and {len(reps)} repetitions.",
        f"- Paired bootstrap: {resamples} scenario resamples, seed {seed}, 95% percentile interval.",
    ]
    if any(record.get("mock") for record in records):
        lines.append("- Warning: This report contains mock records and does not measure model behavior.")
    lines.extend(["", "## Candidate minus original by scenario", ""])
    lines.append("| Scenario | Pass rate | Assertion rate | Critical failures | Tokens | Cost USD | Turns | Duration s |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for scenario in scenarios:
        scenario_pairs = {key: value for key, value in pairs.items() if key[0] == scenario}
        values = []
        for name, _, _ in METRICS:
            deltas = []
            for arms in scenario_pairs.values():
                if name not in QUALITY_METRICS and any(arm.get("error") for arm in arms.values()):
                    continue
                candidate = metric(arms["candidate"], name)
                original = metric(arms["original"], name)
                if candidate is not None and original is not None:
                    deltas.append(candidate - original)
            values.append(statistics.mean(deltas) if deltas else None)
        formatted = [
            f"{values[0]:+.3f}",
            f"{values[1]:+.3f}",
            f"{values[2]:+.2f}",
            f"{values[3]:+.0f}" if values[3] is not None else "N/A",
            f"{values[4]:+.4f}" if values[4] is not None else "N/A",
            f"{values[5]:+.2f}" if values[5] is not None else "N/A",
            f"{values[6]:+.2f}" if values[6] is not None else "N/A",
        ]
        lines.append(
            f"| {scenario} | {' | '.join(formatted)} |"
        )
    lines.extend(["", "## Aggregate paired differences", ""])
    lines.append("| Metric | Candidate minus original | 95% paired interval | Direction |")
    lines.append("|---|---:|---:|---|")
    for index, (name, label, higher_is_better) in enumerate(METRICS):
        deltas = list(scenario_deltas(pairs, name).values())
        direction = "higher is better" if higher_is_better else "lower is better"
        if deltas:
            point, low, high = bootstrap_interval(deltas, seed + index, resamples)
            lines.append(f"| {label} | {point:+.4f} | [{low:+.4f}, {high:+.4f}] | {direction} |")
        else:
            lines.append(f"| {label} | N/A | N/A | {direction} |")
    lines.extend(
        [
            "",
            "The interval resamples scenarios after averaging repetitions within each scenario.",
            "This keeps each direct scenario as the independent paired unit.",
            "A quality improvement needs an interval above zero for pass or assertion rate.",
            "A resource or failure improvement needs an interval below zero.",
            "Resource metrics exclude a pair when either arm has a run error.",
        ]
    )
    errors = [record for record in records if record.get("error")]
    if errors:
        lines.extend(["", "## Run errors", ""])
        for record in errors:
            lines.append(
                f"- {record['scenario']} rep {record['rep']} {record['arm']}: {record['error']}"
            )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", nargs="+", help="JSONL files or run directories")
    parser.add_argument("--out", help="write Markdown to this path")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--resamples", type=int, default=RESAMPLES)
    args = parser.parse_args()
    if args.resamples < 40:
        parser.error("--resamples must be at least 40")
    report = generate(load_records(args.results), args.seed, args.resamples)
    if args.out:
        Path(args.out).write_text(report)
        print(f"wrote {Path(args.out).resolve()}")
    else:
        print(report, end="")


if __name__ == "__main__":
    main()
