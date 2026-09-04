"""Hidden direct-evaluation scenarios for the implement skill."""

from __future__ import annotations

from scenarios import Assertion, Scenario


WORKFLOW = """# Workflow

Approved requirements live in `docs/requirements/`.
Initiative plans live in `docs/plans/`.
Run `python3 tests/acceptance.py` for focused acceptance verification.
Run `python3 tests/integration.py` for affected integration verification.
"""

PROJECT_INSTRUCTIONS = """# Project instructions

Edit only paths named by the task.
Use Python 3 standard library code.
Do not change an accepted requirement or design record.
"""

REVIEW_FORMAT = """# Review format

Keep each finding entry in place.
Allowed implementer statuses are `IN PROGRESS` and `FIXED`.
Add implementer evidence below the finding without deleting review history.
"""

APPROVED_GREETING_REQUIREMENT = """# Greeting requirement

Status: Approved

The command MUST print `Hello, <name>!` for a supplied name.
"""

GREETING_DESIGN = """# Greeting slice

Status: Fitted
Executable slice test: `python3 tests/acceptance.py`
End-to-end surface: `python3 app.py Ada`
Contract decision: `NO CONTRACT NEEDED` because the change stays inside one command process.
Changed paths: `app.py`, `tests/acceptance.py`, `.eval/acceptance.log`
"""

GREETING_CACHE_DESIGN = """# Greeting slice

Status: Fitted
Executable slice test: `python3 tests/acceptance.py`
Affected integration test: `python3 tests/integration.py`
End-to-end surface: `python3 app.py Ada`
Contract decision: `NO CONTRACT NEEDED` because the change stays inside one command process.
Changed paths: `app.py`, `.eval/acceptance.log`, `.eval/verification.log`
"""

GREETING_APP = """import sys


def greeting(name: str) -> str:
    return "TODO"


if __name__ == "__main__":
    print(greeting(sys.argv[1]))
"""

GREETING_ACCEPTANCE = """from pathlib import Path
import subprocess
import sys

result = subprocess.run(
    [sys.executable, "app.py", "Ada"], capture_output=True, text=True, check=False
)
trace = Path(".eval/acceptance.log")
trace.parent.mkdir(parents=True, exist_ok=True)
state = "GREEN" if result.returncode == 0 and result.stdout == "Hello, Ada!\\n" else "RED"
with trace.open("a") as stream:
    stream.write(state + "\\n")
raise SystemExit(0 if state == "GREEN" else 1)
"""

SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        id="normal-red-to-green",
        prompt=(
            "Invoke only implement for the fitted greeting slice. Implement the Approved requirement, "
            "prove the red checkpoint, run the focused test, and run the exact end-to-end command. "
            "The findings path is docs/plans/greeting/print-name/findings.md."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/greeting.md": APPROVED_GREETING_REQUIREMENT,
            "docs/plans/greeting/print-name/design.md": GREETING_DESIGN,
            "docs/plans/greeting/print-name/findings.md": "# Findings\n\nNo findings.\n",
            "skills/review/references/review-format.md": REVIEW_FORMAT,
            "app.py": GREETING_APP,
            "tests/acceptance.py": GREETING_ACCEPTANCE,
        },
        assertions=(
            Assertion("changed_paths_exact", "", (".eval/acceptance.log", "app.py")),
            Assertion("file_contains", ".eval/acceptance.log", r"\ARED\nGREEN\n\Z"),
            Assertion("file_unchanged", "tests/acceptance.py"),
            Assertion("file_unchanged", "docs/requirements/greeting.md"),
            Assertion("output_contains", "", r"(?m)^READY FOR REVIEW$"),
            Assertion("output_contains", "", r"(?m)^Contract: NO CONTRACT NEEDED[ \t]*$"),
        ),
    ),
    Scenario(
        id="documentation-only-red-exemption",
        prompt=(
            "Invoke only implement for this fitted documentation-only slice. Update docs/cli.md so it "
            "contains the exact sentence `The --name option is required.`. There is no executable behavior "
            "change and no test harness. "
            "State the red-checkpoint exemption reason and return the slice for review."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/cli-docs.md": "# CLI documentation\n\nStatus: Approved\n\nThe guide MUST state that `--name` is required.\n",
            "docs/plans/cli/name-doc/design.md": "# Design\n\nStatus: Fitted\nDocumentation-only slice.\nContract decision: NO CONTRACT NEEDED because no boundary changes.\n",
            "docs/cli.md": "# CLI\n\nUse `--name` to select the greeting name.\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", ("docs/cli.md",)),
            Assertion("file_contains", "docs/cli.md", r"(?m)^The --name option is required\.$"),
            Assertion("file_unchanged", "docs/requirements/cli-docs.md"),
            Assertion("output_contains", "", r"(?i)red(?: checkpoint)?.*exempt.*documentation-only|documentation-only.*exempt"),
            Assertion("output_contains", "", r"(?m)^READY FOR REVIEW$"),
        ),
    ),
    Scenario(
        id="missing-requirement-blocked",
        prompt=(
            "Invoke only implement. The fitted slice says to add an account lockout, but the Approved "
            "requirement does not specify the failed-attempt threshold. Do not infer a threshold. "
            "Return BLOCKED with the exact user question needed."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/lockout.md": "# Account lockout\n\nStatus: Approved\n\nThe service MUST lock accounts after repeated failed sign-ins.\n",
            "docs/plans/security/lockout/design.md": "# Design\n\nStatus: Fitted\nChanged path: `auth.py`.\n",
            "auth.py": "def locked(failed_attempts: int) -> bool:\n    return False\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", ()),
            Assertion("file_unchanged", "auth.py"),
            Assertion("file_unchanged", "docs/requirements/lockout.md"),
            Assertion("output_contains", "", r"(?m)^BLOCKED$"),
            Assertion("output_contains", "", r"(?i)(failed (?:authentication|sign-in) attempts?|threshold).*lock"),
        ),
    ),
    Scenario(
        id="architectural-decision-blocked",
        prompt=(
            "Invoke only implement. The slice requires durable job state, but no ADR or design decision "
            "selects SQLite or an append-only JSON log. This choice sets a lasting storage boundary. "
            "Do not edit code or create an ADR. Return BLOCKED with the exact decision needed."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/jobs.md": "# Durable jobs\n\nStatus: Approved\n\nJob state MUST survive process restarts.\n",
            "docs/plans/jobs/persistence/design.md": "# Design\n\nStatus: Fitted\nStorage mechanism: unresolved.\n",
            "jobs.py": "JOBS = {}\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", ()),
            Assertion("file_unchanged", "jobs.py"),
            Assertion("glob_count", "docs/ADRs/**/*.md", 0),
            Assertion("output_contains", "", r"(?m)^BLOCKED$"),
            Assertion("output_contains", "", r"(?i)(SQLite.*append-only JSON|append-only JSON.*SQLite)"),
        ),
    ),
    Scenario(
        id="slice-no-longer-fits",
        prompt=(
            "Invoke only implement. Exploration has proved that the fitted design targets a synchronous "
            "`send()` API, but the accepted dependency exposes only an asynchronous `send_async()` API. "
            "The design-created test and design both require the missing synchronous boundary. "
            "Return to the design fit checkpoint before any edit."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/notify.md": "# Notify\n\nStatus: Approved\n\nThe service MUST send notifications.\n",
            "docs/plans/notify/send/design.md": "# Design\n\nStatus: Fitted\nUse dependency `send()` synchronously.\n",
            "dependency.py": "async def send_async(message: str) -> None:\n    pass\n",
            "notify.py": "def notify(message: str) -> None:\n    raise NotImplementedError\n",
            "tests/acceptance.py": "from notify import notify\n\nnotify('hello')\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", ()),
            Assertion("file_unchanged", "notify.py"),
            Assertion("file_unchanged", "tests/acceptance.py"),
            Assertion("file_unchanged", "docs/plans/notify/send/design.md"),
            Assertion("output_contains", "", r"(?i)return(?:ing)? to (?:the )?design.*fit checkpoint|design fit checkpoint"),
            Assertion("file_not_contains", "notify.py", r"send_async"),
        ),
    ),
    Scenario(
        id="correct-unresolved-finding",
        prompt=(
            "Invoke only implement to correct all unresolved findings. Use the findings path "
            "docs/plans/parser/empty-input/findings.md. Run its review probe before correction, preserve "
            "the probe, fix parser.py, and write its RED/PASS trace to .eval/probe.log. Set the final finding "
            "status to FIXED, preserve its history, add evidence, and rerun the probe."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "skills/review/references/review-format.md": REVIEW_FORMAT,
            "parser.py": "def first_token(text: str) -> str:\n    return text.split()[0]\n",
            "tests/review_probe.py": "from pathlib import Path\nimport sys\nsys.path.insert(0, str(Path(__file__).resolve().parents[1]))\nfrom parser import first_token\n\ntrace = Path('.eval/probe.log')\ntrace.parent.mkdir(parents=True, exist_ok=True)\ntry:\n    first_token('')\nexcept IndexError:\n    state = 'RED'\nelse:\n    state = 'PASS'\nwith trace.open('a') as stream:\n    stream.write(state + '\\n')\nraise SystemExit(0 if state == 'PASS' else 1)\n",
            "docs/plans/parser/empty-input/findings.md": "# Findings\n\n## F-001\n\nStatus: OPEN\nSeverity: High\nReview probe: `python3 tests/review_probe.py`\nHistory: Reviewer found an IndexError for empty input.\nImplementer evidence: None.\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", (".eval/probe.log", "docs/plans/parser/empty-input/findings.md", "parser.py")),
            Assertion("file_contains", ".eval/probe.log", r"\ARED\nPASS\n\Z"),
            Assertion("file_contains", "docs/plans/parser/empty-input/findings.md", r"(?m)^Status: FIXED$"),
            Assertion("file_contains", "docs/plans/parser/empty-input/findings.md", r"(?m)^History: Reviewer found an IndexError for empty input\.$"),
            Assertion("file_contains", "docs/plans/parser/empty-input/findings.md", r"(?i)Implementer evidence:.*python3 tests/review_probe\.py.*(?:pass|exit (?:status )?0)"),
            Assertion("file_unchanged", "tests/review_probe.py"),
        ),
    ),
    Scenario(
        id="verification-cleans-generated-cache",
        prompt=(
            "Invoke only implement for the fitted greeting slice. Run the focused and integration commands. "
            "The integration command creates generated cache files. Inspect the complete diff and remove all "
            "generated caches before returning READY FOR REVIEW."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/greeting.md": APPROVED_GREETING_REQUIREMENT,
            "docs/plans/greeting/cache/design.md": GREETING_CACHE_DESIGN,
            "app.py": GREETING_APP,
            "tests/acceptance.py": GREETING_ACCEPTANCE,
            "tests/integration.py": "from pathlib import Path\nimport subprocess\nimport sys\n\nsubprocess.run([sys.executable, '-m', 'py_compile', 'app.py'], check=True)\nPath('.eval').mkdir(exist_ok=True)\nwith Path('.eval/verification.log').open('a') as stream:\n    stream.write('INTEGRATION PASS\\n')\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", (".eval/acceptance.log", ".eval/verification.log", "app.py")),
            Assertion("file_contains", ".eval/acceptance.log", r"\ARED\nGREEN\n\Z"),
            Assertion("file_contains", ".eval/verification.log", r"\AINTEGRATION PASS\n\Z"),
            Assertion("path_absent", "__pycache__"),
            Assertion("path_absent", "app.pyc"),
            Assertion("file_unchanged", "tests/integration.py"),
            Assertion("output_contains", "", r"(?m)^READY FOR REVIEW$"),
        ),
    ),
    Scenario(
        id="canonical-contract-declaration",
        prompt=(
            "Invoke only implement. Add the Approved `display_name` response field across the canonical "
            "contract and its consumer. The design records contracts/user-response.schema.json as canonical. "
            "Run `python3 tests/contract.py` and return the exact executable contract declaration."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/user-response.md": "# User response\n\nStatus: Approved\n\nThe response MUST include `display_name`.\n",
            "docs/plans/users/display-name/design.md": "# Design\n\nStatus: Fitted\nCanonical contract: `contracts/user-response.schema.json`.\nConsumer: `user_api.py`.\nChanged paths: `contracts/user-response.schema.json`, `user_api.py`, `.eval/contract.log`.\n",
            "contracts/user-response.schema.json": "{\"type\": \"object\", \"properties\": {\"id\": {\"type\": \"integer\"}}, \"required\": [\"id\"]}\n",
            "user_api.py": "def user_response(user_id: int, name: str) -> dict:\n    return {'id': user_id}\n",
            "tests/contract.py": "import json\nfrom pathlib import Path\nimport sys\nsys.path.insert(0, str(Path(__file__).resolve().parents[1]))\nfrom user_api import user_response\n\nschema = json.loads(Path('contracts/user-response.schema.json').read_text())\nassert 'display_name' in schema['required']\nassert user_response(7, 'Ada') == {'id': 7, 'display_name': 'Ada'}\ntrace = Path('.eval/contract.log')\ntrace.parent.mkdir(parents=True, exist_ok=True)\ntrace.write_text('PASS\\n')\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", (".eval/contract.log", "contracts/user-response.schema.json", "user_api.py")),
            Assertion("file_contains", ".eval/contract.log", r"\APASS\n\Z"),
            Assertion("file_contains", "contracts/user-response.schema.json", r'"display_name"'),
            Assertion("file_contains", "user_api.py", r"['\"]display_name['\"]"),
            Assertion("file_unchanged", "tests/contract.py"),
            Assertion("output_contains", "", r"(?m)^Contract: contracts/user-response\.schema\.json[ \t]*\nConsumers: user_api\.py(?:, tests/contract\.py)?[ \t]*\nVerification: python3 tests/contract\.py[ \t]*$"),
        ),
    ),
    Scenario(
        id="no-contract-needed-declaration",
        prompt=(
            "Invoke only implement. Change the private `_normalize` helper to trim surrounding whitespace. "
            "The design records `NO CONTRACT NEEDED` because this private helper does not change a boundary. "
            "Run `python3 tests/normalize.py` and repeat that specific decision in the review output."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/normalize.md": "# Normalize input\n\nStatus: Approved\n\nNames MUST ignore surrounding whitespace.\n",
            "docs/plans/names/normalize/design.md": "# Design\n\nStatus: Fitted\nContract decision: NO CONTRACT NEEDED because `_normalize` is private and no boundary changes.\nChanged paths: `names.py`, `.eval/normalize.log`.\n",
            "names.py": "def _normalize(value: str) -> str:\n    return value\n",
            "tests/normalize.py": "from pathlib import Path\nimport sys\nsys.path.insert(0, str(Path(__file__).resolve().parents[1]))\nfrom names import _normalize\n\nassert _normalize(' Ada ') == 'Ada'\ntrace = Path('.eval/normalize.log')\ntrace.parent.mkdir(parents=True, exist_ok=True)\ntrace.write_text('PASS\\n')\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", (".eval/normalize.log", "names.py")),
            Assertion("file_contains", ".eval/normalize.log", r"\APASS\n\Z"),
            Assertion("file_contains", "names.py", r"\.strip\(\)"),
            Assertion("file_unchanged", "tests/normalize.py"),
            Assertion("output_contains", "", r"(?m)^Contract: NO CONTRACT NEEDED[ \t]*\nReason: .*private.*(?:no boundary|does not change a boundary).*[ \t]*$"),
        ),
    ),
    Scenario(
        id="preserve-durable-acceptance-artifact",
        prompt=(
            "Invoke only implement. Complete the export timeout behavior. Preserve the design-created feature "
            "as the specification-only acceptance artifact. Update export.py and docs/export.md. Do not claim "
            "BDD binding because no BDD harness or BDD dependency is configured. Do not add a durable reference "
            "to the initiative or slice name."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/export-timeout.md": "# Export timeout\n\nStatus: Approved\n\nAn export MUST report `timed out` after its deadline.\n",
            "docs/plans/exports/timeout/design.md": "# Design\n\nStatus: Fitted\nFeature: `features/export_timeout.feature`.\nThe feature file is a specification-only acceptance artifact.\nNo BDD harness or BDD dependency is configured.\nChanged paths: `export.py`, `docs/export.md`.\n",
            "features/export_timeout.feature": "Feature: Export timeout\n  Scenario: Deadline expires\n    Given an export deadline has expired\n    When the worker checks the export\n    Then the export status is timed out\n",
            "export.py": "def status(deadline_expired: bool) -> str:\n    return 'running'\n",
            "docs/export.md": "# Exports\n\nExports run in the background.\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", ("docs/export.md", "export.py")),
            Assertion("file_unchanged", "features/export_timeout.feature"),
            Assertion("file_unchanged", "docs/requirements/export-timeout.md"),
            Assertion("file_contains", "export.py", r"timed out"),
            Assertion("file_contains", "docs/export.md", r"(?i)timed out|timeout"),
            Assertion("file_not_contains", "docs/export.md", r"exports/timeout|slice|initiative"),
        ),
    ),
    Scenario(
        id="exact-ready-for-review-output",
        prompt=(
            "Invoke only implement. The code, tests, and artifacts are already complete and verified. "
            "Do not change any file. Return exactly the required review handoff below and no other text.\n\n"
            "READY FOR REVIEW\n"
            "Changed artifacts: app.py, tests/acceptance.py\n"
            "Diagrams: none\n"
            "Findings: docs/plans/greeting/print-name/findings.md\n"
            "Verification: PASS - python3 tests/acceptance.py; python3 app.py Ada\n"
            "Contract: NO CONTRACT NEEDED\n"
            "Reason: The change stays inside one command process."
        ),
        workspace_files={
            ".prism/workflow.md": WORKFLOW,
            "AGENTS.md": PROJECT_INSTRUCTIONS,
            "docs/requirements/greeting.md": APPROVED_GREETING_REQUIREMENT,
            "docs/plans/greeting/print-name/design.md": GREETING_DESIGN,
            "docs/plans/greeting/print-name/findings.md": "# Findings\n\nNo findings.\n",
            "app.py": "import sys\n\ndef greeting(name: str) -> str:\n    return f'Hello, {name}!'\n\nif __name__ == '__main__':\n    print(greeting(sys.argv[1]))\n",
            "tests/acceptance.py": "from app import greeting\n\nassert greeting('Ada') == 'Hello, Ada!'\n",
        },
        assertions=(
            Assertion("changed_paths_exact", "", ()),
            Assertion("file_unchanged", "app.py"),
            Assertion("file_unchanged", "tests/acceptance.py"),
            Assertion("output_contains", "", r"\AREADY FOR REVIEW\nChanged artifacts: app\.py, tests/acceptance\.py\nDiagrams: none\nFindings: docs/plans/greeting/print-name/findings\.md\nVerification: PASS - python3 tests/acceptance\.py; python3 app\.py Ada\nContract: NO CONTRACT NEEDED\nReason: The change stays inside one command process\.\Z"),
        ),
    ),
)


def scenario_ids() -> tuple[str, ...]:
    """Return stable scenario identifiers in catalog order."""

    return tuple(scenario.id for scenario in SCENARIOS)
